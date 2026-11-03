/**
 * Browser-side SoDEX trading client.
 *
 * All calls go directly from the user's browser to mainnet-gw or
 * testnet-gw — Helix's server is NEVER in the path. CORS is open on
 * both gateways, so there is no proxy involvement, no API-key secret
 * crossing our server, no audit-log trust issue: the user signs in
 * their browser and the bytes go straight to SoDEX.
 *
 * The only thing Helix's server sees is an after-the-fact audit log
 * notification posted by the client once a trade fills.
 */

import type { Hex } from "viem";
import {
  SODEX_NETWORKS,
  getBuilderCode,
  valueChainAddParams,
  type SodexNetwork,
} from "./chains";
import {
  signAddAPIKeyAction,
  signApproveBuilderFeeAction,
  signWithApiKey,
  signWithMasterWallet,
  type Eip1193Provider,
} from "./signing";
import type {
  SodexAccountState,
  SodexAction,
  SodexApiKeyRow,
  SodexCancelItem,
  SodexCancelOrderParams,
  SodexClosedPosition,
  SodexFundingPayment,
  SodexNewOrderBatch,
  SodexOpenOrder,
  SodexOrderHistory,
  SodexRevokeApiKeyParams,
  SodexTrade,
} from "./types";
import { SodexApiKeyType } from "./types";

interface SodexResponse<T> {
  code: number;
  timestamp: number;
  data?: T;
  /** Some endpoints use `msg`, others `error`. We surface either. */
  msg?: string;
  error?: string;
}

/**
 * Look up SoDEX's numeric `symbolID` for a textual spot symbol.
 *
 * SoDEX assigns each market a numeric ID; the trading API expects
 * that integer, not the human-readable symbol. We fetch the catalog
 * once from /markets/symbols and memoize per network.
 *
 * Earlier this code hit `/trade/symbols` which 404s; the empty cache
 * caused every ExecuteLive click to fail with
 *   "Symbol vBTC_vUSDC not listed on SoDEX Mainnet."
 * even though the symbol format was correct.
 *
 * Canonical endpoint shape (verified against mainnet-gw on 2026-06-07):
 *   GET /markets/symbols  →  { code, timestamp, data: [
 *     { id: 1, name: "vBTC_vUSDC", displayName: "BTC/USDC", … },
 *     { id: 2, name: "vETH_vUSDC", displayName: "ETH/USDC", … },
 *     …
 *   ]}
 * The symbol identifier we send to /trade/place lives in `name`. The
 * legacy `symbol` field doesn't exist on this endpoint, but we accept
 * both shapes so callers passing either format still resolve.
 */
/** Which SoDEX venue a symbol trades on. "futures" = perps. */
export type SodexMarket = "spot" | "futures";

/** Resolved market metadata — id + the sizing constraints an order must obey. */
export interface SodexSymbolMeta {
  id: number;
  market: SodexMarket;
  /** Decimal places allowed on `quantity` (e.g. DASH perp = 2). */
  quantityPrecision?: number;
  /** Decimal places allowed on price / stopPrice (e.g. DASH perp = 3). */
  pricePrecision?: number;
  /** Quantity step, decimal string (e.g. "0.01"). */
  stepSize?: string;
  minQuantity?: string;
  minNotional?: string;
}

// Cached per `${network}:${market}` — spot and futures have separate catalogs.
const _symbolMapCache = new Map<string, Map<string, SodexSymbolMeta>>();

async function loadSymbolMap(
  network: SodexNetwork,
  market: SodexMarket,
): Promise<Map<string, SodexSymbolMeta>> {
  const cacheKey = `${network}:${market}`;
  const cached = _symbolMapCache.get(cacheKey);
  if (cached) return cached;
  const map = new Map<string, SodexSymbolMeta>();
  try {
    const net = SODEX_NETWORKS[network];
    const endpoint = market === "futures" ? net.perpsEndpoint : net.spotEndpoint;
    const res = await fetch(`${endpoint}/markets/symbols`);
    const json = (await res.json()) as {
      code: number;
      data?: Array<{
        id?: number;
        name?: string;
        symbol?: string;
        displayName?: string;
        quantityPrecision?: number;
        pricePrecision?: number;
        stepSize?: string;
        minQuantity?: string;
        minNotional?: string;
      }>;
    };
    if (json.code === 0 && json.data) {
      for (const s of json.data) {
        const id = s.id;
        if (id == null) continue;
        const meta: SodexSymbolMeta = {
          id,
          market,
          quantityPrecision: s.quantityPrecision,
          pricePrecision: s.pricePrecision,
          stepSize: s.stepSize,
          minQuantity: s.minQuantity,
          minNotional: s.minNotional,
        };
        // Index under `name` (canonical), `symbol` (legacy) and
        // `displayName` so a caller can search by "BTC/USDC" too.
        for (const key of [s.name, s.symbol, s.displayName]) {
          const k = (key ?? "").toUpperCase();
          if (k) map.set(k, meta);
        }
      }
    }
  } catch {
    /* fall back to empty map; caller will get undefined */
  }
  _symbolMapCache.set(cacheKey, map);
  return map;
}

/** Numeric symbolID on a SPECIFIC market (default spot). */
export async function getSymbolId(
  network: SodexNetwork,
  symbol: string,
  market: SodexMarket = "spot",
): Promise<number | undefined> {
  const map = await loadSymbolMap(network, market);
  return map.get(symbol.toUpperCase())?.id;
}

/**
 * Resolve a textual symbol to its market metadata, checking SPOT first then
 * FUTURES (perps). Perp-only assets (e.g. DASH-USD) are absent from the spot
 * catalog, so a spot-only lookup wrongly reports "not listed" — this finds
 * them on the futures venue and returns the id + sizing constraints.
 */
export async function resolveSymbol(
  network: SodexNetwork,
  symbol: string,
): Promise<SodexSymbolMeta | undefined> {
  const spot = (await loadSymbolMap(network, "spot")).get(symbol.toUpperCase());
  if (spot) return spot;
  const fut = (await loadSymbolMap(network, "futures")).get(
    symbol.toUpperCase(),
  );
  if (fut) return fut;
  return undefined;
}

/**
 * Live ticker for a SoDEX spot symbol.
 *
 * Used by ExecuteLiveButton to convert a USD spend into a base-asset
 * quantity at click time (signals don't carry a live price). Returns
 * the best-ask for BUY-side conversion, best-bid for SELL-side. Falls
 * back to lastPx if either side of the book is empty.
 *
 * SoDEX exposes only an "all tickers" snapshot — there's no per-symbol
 * endpoint — so we fetch once and pick the entry by name. The payload
 * is ~30 markets so the bandwidth cost is fine even at click latency.
 */
export interface SodexTicker {
  symbol: string;
  lastPx: string;
  askPx?: string;
  bidPx?: string;
  /** Perps only — the mark price used for PnL / liquidation. */
  markPrice?: string;
}
export async function getTicker(
  network: SodexNetwork,
  symbolName: string,
  market: SodexMarket = "spot",
): Promise<SodexTicker | undefined> {
  const net = SODEX_NETWORKS[network];
  const endpoint = market === "futures" ? net.perpsEndpoint : net.spotEndpoint;
  const res = await fetch(`${endpoint}/markets/tickers`);
  const json = (await res.json()) as {
    code: number;
    data?: Array<SodexTicker>;
  };
  if (json.code !== 0 || !json.data) return undefined;
  // SoDEX returns symbols in mixed conventions (vBTC_vUSDC vs vBTCssi);
  // compare case-insensitively.
  const want = symbolName.toUpperCase();
  return json.data.find((t) => (t.symbol ?? "").toUpperCase() === want);
}

/**
 * Best-effort live mid price for converting USD-size to base-asset
 * quantity. Returns the side of the book the BUY/SELL would consume —
 * bestAsk for BUY (you cross the spread up), bestBid for SELL (you
 * cross the spread down). Falls back to lastPx, then null.
 */
export async function getLivePrice(
  network: SodexNetwork,
  symbolName: string,
  side: "buy" | "sell",
  market: SodexMarket = "spot",
): Promise<number | null> {
  const t = await getTicker(network, symbolName, market);
  if (!t) return null;
  const pick = side === "buy" ? t.askPx : t.bidPx;
  const candidates = [pick, t.lastPx].filter(Boolean) as string[];
  for (const v of candidates) {
    const n = parseFloat(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

async function handle<T>(res: Response): Promise<T> {
  // Read as text first so a non-JSON body (e.g. a gateway "404 page not
  // found") surfaces a clean message instead of an "Unexpected non-
  // whitespace character after JSON" parse crash.
  const raw = await res.text();
  let json: SodexResponse<T>;
  try {
    json = JSON.parse(raw) as SodexResponse<T>;
  } catch {
    throw new Error(
      `SoDEX ${res.status}: ${raw.slice(0, 160).trim() || "non-JSON response"}`,
    );
  }
  if (json.code !== 0) {
    // Surface whichever message field the endpoint used. Helpful
    // distinguishing "Nonce out of window" vs "invalid signature"
    // vs "ecrecover address mismatch" etc.
    const msg = json.msg ?? json.error ?? `code ${json.code}`;
    throw new Error(msg);
  }
  if (json.data === undefined) {
    // /exchange endpoints often return only {code:0,msg:"success"}
    // with no data field — accept that as a success.
    return undefined as T;
  }
  return json.data;
}

export type OrderStatus = "ok" | "rejected" | "unconfirmed";
export interface OrderOutcome {
  status: OrderStatus;
  orderID?: number | string | null;
  reason?: string;
}

/**
 * Classify a single order's PER-ORDER result from a gateway 200 (top-level
 * `code:0`). handle() only checks the top-level code, so a rejected order used
 * to look like success — the P0 where a TP/SL "placed" from our UI never rested
 * on SoDEX. Three outcomes, reported per order so callers can show partial
 * success (entry ok + bracket rejected) instead of a blanket failure:
 *   - rejected:    an explicit non-zero per-order code, or an error message
 *                  with no orderID → show SoDEX's reason, never "placed".
 *   - ok:          code 0 / an orderID present.
 *   - unconfirmed: neither clear success nor clear error → "check positions",
 *                  never success OR failure; callers re-read the GET endpoints.
 */
export function classifyOrderResult(data: unknown): OrderOutcome {
  const row = Array.isArray(data)
    ? data[0]
    : data && typeof data === "object" && Array.isArray((data as { orders?: unknown[] }).orders)
      ? (data as { orders: unknown[] }).orders[0]
      : data;
  if (!row || typeof row !== "object") return { status: "unconfirmed" };
  const o = row as Record<string, unknown>;
  const code = o.code ?? o.errCode ?? o.errorCode;
  if (typeof code === "number" && code !== 0) {
    return {
      status: "rejected",
      reason: String(o.msg ?? o.error ?? o.reason ?? `code ${code}`),
    };
  }
  const orderID = (o.orderID ?? o.orderId ?? null) as number | string | null;
  const hasId = orderID != null && orderID !== 0 && orderID !== "0";
  if (hasId || code === 0) return { status: "ok", orderID };
  const msg = o.msg ?? o.error ?? o.reason;
  if (typeof msg === "string" && msg && !/success|ok|accept/i.test(msg)) {
    return { status: "rejected", reason: msg };
  }
  return { status: "unconfirmed" };
}

/** GET /spot/accounts/{address}/state — returns account ID + balances. */
export async function getAccountState(
  network: SodexNetwork,
  address: `0x${string}`,
): Promise<SodexAccountState> {
  const { spotEndpoint } = SODEX_NETWORKS[network];
  const res = await fetch(`${spotEndpoint}/accounts/${address}/state`);
  return handle<SodexAccountState>(res);
}

/**
 * GET /perps/accounts/{address}/state — returns the perps account
 * envelope (aid + margin breakdown + balances + positions + orders).
 *
 * A wallet that's only ever traded spot will get an `aid:0` zero-state
 * response here. The current Helix execution path is spot-only, so
 * this is informational for the UI ("you also have $X on perps");
 * we don't sign perps orders from this codebase yet.
 */
export async function getPerpsAccountState(
  network: SodexNetwork,
  address: `0x${string}`,
): Promise<import("./types").SodexPerpsAccountState> {
  const { perpsEndpoint } = SODEX_NETWORKS[network];
  const res = await fetch(`${perpsEndpoint}/accounts/${address}/state`);
  return handle<import("./types").SodexPerpsAccountState>(res);
}

/** GET /accounts/{address}/api-keys — returns rows we already know. */
export async function listApiKeys(
  network: SodexNetwork,
  address: `0x${string}`,
): Promise<SodexApiKeyRow[]> {
  const { spotEndpoint } = SODEX_NETWORKS[network];
  const res = await fetch(`${spotEndpoint}/accounts/${address}/api-keys`);
  return handle<SodexApiKeyRow[]>(res);
}

/**
 * POST /accounts/api-keys — signed by master wallet.
 *
 * The action envelope hashed for the signature is the full
 * {type, params} object; the HTTP body is the inner params alone.
 */
export async function addApiKey(opts: {
  network: SodexNetwork;
  provider: Eip1193Provider;
  account: `0x${string}`;
  accountID: number;
  name: string;
  publicKey: `0x${string}`;
  /** Unix-millis. 0 means no expiry; SoDEX caps at 7 days from now. */
  expiresAt?: number;
}): Promise<{ name: string }> {
  const { network, provider, account, accountID, name, publicKey } = opts;
  const { chainId, spotEndpoint, perpsEndpoint } = SODEX_NETWORKS[network];

  // Default: 7-day expiry (the SoDEX UI's default behavior — see
  // EXPIRED_DAYS=7 in their bundle).
  const expiresAt =
    opts.expiresAt ?? Date.now() + 7 * 24 * 60 * 60 * 1000;

  // signAddAPIKeyAction returns the raw 65-byte signature (no 0x01
  // prefix) AND the wallet's current chainId — which we need to
  // include in the universal-action body as `signatureChainID`.
  const { apiSign, nonce, walletChainId } = await signAddAPIKeyAction({
    provider,
    account,
    sodexChainId: chainId,
    accountID,
    name,
    keyType: SodexApiKeyType.EVM,
    publicKey,
    expiresAt,
  });

  // SoDEX's addAPIKey goes through the "universal" exchange endpoint,
  // NOT the /accounts/api-keys X-API-Sign path. The body holds the
  // full action envelope including the signature + the wallet's
  // chainId — no auth headers are sent.
  //
  //   POST /api/v1/spot/exchange
  //   body: { type, params, nonce, signature, signatureChainID }
  //
  // Reverse-engineered from testnet.sodex.com bundle.
  const body = {
    type: "addAPIKey",
    params: {
      accountID,
      type: SodexApiKeyType.EVM,
      name,
      publicKey,
      expiresAt,
    },
    nonce: Number(nonce),
    signature: apiSign,
    signatureChainID: walletChainId,
  };

  // Register on the SPOT gateway (required).
  const res = await fetch(`${spotEndpoint}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await handle<unknown>(res);

  // ALSO register on the PERPS gateway — it keeps a SEPARATE api-key registry,
  // so without this every perps order fails with "API key not found". The
  // addAPIKey signature is universal (account-wide), so the exact same body is
  // valid on both gateways. Best-effort: a perps failure must not break the
  // (already-succeeded) spot setup.
  try {
    const perpsRes = await fetch(`${perpsEndpoint}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await handle<unknown>(perpsRes);
  } catch {
    /* perps registration is best-effort */
  }
  return { name };
}

/**
 * Make sure the wallet is on ValueChain (SoDEX's EVM chain) before signing an
 * account-level action whose EIP-712 domain uses that chain id. Switches via
 * wallet_switchEthereumChain, adding the network (EIP-3085) first if the wallet
 * doesn't recognise it. Best-effort: if the provider can't report or switch
 * chains we let signing proceed (it may still work, or fail clearly).
 */
async function ensureWalletOnSodexChain(
  provider: Eip1193Provider,
  network: SodexNetwork,
): Promise<void> {
  const target = SODEX_NETWORKS[network].chainId;
  let current: number | null = null;
  try {
    current = parseInt(
      (await provider.request({ method: "eth_chainId", params: [] })) as string,
      16,
    );
  } catch {
    return;
  }
  if (current === target) return;

  const params = valueChainAddParams(network);
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: params.chainId }],
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    const msg = (err as Error).message ?? "";
    // 4902 (or an equivalent message) = the chain isn't in the wallet yet.
    if (code === 4902 || /unrecognized|not been added|add.*chain/i.test(msg)) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [params],
      });
      // addEthereumChain usually leaves the wallet on the new chain; make sure.
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: params.chainId }],
        });
      } catch {
        /* added + already switched */
      }
    } else {
      throw err;
    }
  }
}

/**
 * Approve Helix's builder fee — signed ONCE by the master wallet. After this,
 * orders routed by Helix that carry its `builder` code share a fee up to
 * `maxFeeRate` (tenths of a bp; capped per engine: spot ≤2000, perps ≤200).
 *
 * Unlike addAPIKey (which Helix sends via the /exchange envelope), the builder
 * approval uses the gateway's account-level REST shape — matched to the
 * official SoDEX SDK:
 *   POST {gatewayRoot}/api/v1/user/{address}/builders
 *   body:    { accountID, builderID, maxFeeRate }
 *   headers: X-API-Sign (0x02‖r‖s‖v), X-API-Nonce, X-API-Chain = SoDEX chain id
 * The EIP-712 domain is signed with the SoDEX chain id (NOT the wallet's), so
 * X-API-Chain and the signature agree. One call covers both engines.
 */
export async function approveBuilderFee(opts: {
  network: SodexNetwork;
  provider: Eip1193Provider;
  account: `0x${string}`;
  accountID: number;
  builderID: number;
  /** Tenths of a basis point, 0–2000. 0 clears the approval. */
  maxFeeRate: number;
}): Promise<void> {
  const { network, provider, account, accountID, builderID, maxFeeRate } = opts;
  const { chainId, spotEndpoint } = SODEX_NETWORKS[network];
  // Gateway root is the spot endpoint without the /api/v1/spot suffix; the
  // account-level endpoints (…/user/…) hang off the root, not an engine.
  const gatewayRoot = spotEndpoint.replace(/\/api\/v1\/spot\/?$/, "");

  // The approval's EIP-712 domain uses the ValueChain chain id, so the wallet
  // must be ON ValueChain to produce (and for the gateway to recover) a valid
  // signature. Switch the wallet there first — adding the network if the user
  // doesn't have it yet — so they don't have to do it by hand.
  await ensureWalletOnSodexChain(provider, network);

  const { apiSign, nonce } = await signApproveBuilderFeeAction({
    provider,
    account,
    sodexChainId: chainId,
    accountID,
    builderID,
    maxFeeRate,
  });

  const res = await fetch(
    `${gatewayRoot}/api/v1/user/${account}/builders`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-API-Sign": apiSign,
        "X-API-Nonce": nonce.toString(),
        "X-API-Chain": chainId.toString(),
      },
      body: JSON.stringify({ accountID, builderID, maxFeeRate }),
    },
  );
  await handle<unknown>(res);
}

/** DELETE /accounts/api-keys — signed by master wallet. */
export async function revokeApiKey(opts: {
  network: SodexNetwork;
  provider: Eip1193Provider;
  account: `0x${string}`;
  accountID: number;
  name: string;
}): Promise<void> {
  const { network, provider, account, accountID, name } = opts;
  const { chainId, spotEndpoint } = SODEX_NETWORKS[network];

  const params: SodexRevokeApiKeyParams = { accountID, name };
  const action: SodexAction<SodexRevokeApiKeyParams> = {
    type: "revokeAPIKey",
    params,
  };

  const { apiSign, nonce } = await signWithMasterWallet({
    provider,
    account,
    domainName: "spot",
    chainId,
    action,
  });

  const res = await fetch(`${spotEndpoint}/accounts/api-keys`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      "X-API-Sign": apiSign,
      "X-API-Nonce": nonce.toString(),
    },
    body: JSON.stringify(params),
  });
  await handle<unknown>(res);
}

/**
 * POST /trade/orders/batch.
 *
 * Two signing modes:
 *
 *   1. Burner-wallet mode (testnet, no addAPIKey required) — pass
 *      only `privateKey`; the wallet IS the trading identity, so we
 *      sign with that key and OMIT the X-API-Key header. This is the
 *      Hyperliquid-style flow SoDEX uses on testnet.
 *
 *   2. Master-wallet + API-key mode (mainnet, fully revocable) —
 *      pass both `apiKeyName` AND `privateKey`. The signature is
 *      with the API key's private key; we include X-API-Key so the
 *      gateway knows which named key it belongs to.
 */
export async function placeOrderBatch(opts: {
  network: SodexNetwork;
  /** Omit for burner mode — present only for master+API-key mode. */
  apiKeyName?: string;
  privateKey: Hex;
  batch: SodexNewOrderBatch;
  /** "futures" routes to the perps gateway + "futures" signing domain. */
  market?: SodexMarket;
}): Promise<unknown> {
  const { network, apiKeyName, privateKey, batch, market = "spot" } = opts;
  const { chainId, spotEndpoint, perpsEndpoint } = SODEX_NETWORKS[network];
  const endpoint = market === "futures" ? perpsEndpoint : spotEndpoint;

  // Helix's builder code (fee sharing). Null = unconfigured → no `builder`
  // field is added, so the signed payload is byte-identical to before. When
  // set, `builder` MUST be the LAST field of the signed params (id before
  // fee) or the payload hash — and the recovered signer — change.
  const builder = getBuilderCode(network);
  const builderField = builder
    ? { id: builder.id, fee: builder.fee }
    : null;

  // SoDEX's gateway expects decimal strings in MINIMAL form — trailing zeros
  // (and a trailing dot) stripped — and its OWN web client normalizes every
  // price/quantity/funds/stopPrice this way before signing (reverse-engineered
  // from testnet.sodex.com's bundle: fn `nme`). A value already minimal
  // ("85000", "0.009", "204.31") is returned unchanged, so the working
  // MARKET/LIMIT payloads stay byte-identical; a padded "1200.00" → "1200" is
  // the fix for the trigger the gateway rejected as "stopPrice is invalid".
  const dec = (v: string): string => {
    if (!v.includes(".")) return v;
    let end = v.length;
    while (end > 0 && v[end - 1] === "0") end--;
    if (end > 0 && v[end - 1] === ".") end--;
    return v.slice(0, end);
  };

  // SPOT batches to /trade/orders/batch with the "batchNewOrder" action.
  // PERPS expose only /trade/orders and expect a SINGLE FLAT order
  // ("NewOrderParams") — a batch body fails with
  //   "invalid request body: NewOrderParams.SymbolID … required"
  // because SymbolID is nested inside orders[]. So for futures we unwrap
  // the (single) order and sign the "newOrder" action. The action type
  // for the batch path is "batchNewOrder"; single is "newOrder" (docs).
  let action: SodexAction;
  let body: unknown;
  let path: string;
  if (market === "futures") {
    const first = batch.orders[0];
    // SoDEX perps NewOrderParams validation requires BOTH a top-level order
    // AND an `orders` array (an orders-only body → "SymbolID required"; a
    // flat body → "Orders required"). So we send the single order at the top
    // level and mirror it into orders[]. Perps are quantity-based (no funds).
    // Field order matters for the signed payloadHash — keep it stable.
    // PerpsOrderItem in the DOCUMENTED field order (from SoDEX docs):
    //   clOrdID, modifier, side, type, timeInForce, price, quantity, funds,
    //   stopPrice, stopType, triggerType, reduceOnly, positionSide
    // Field order is load-bearing for the signed payloadHash (wrong order →
    // wrong recovered signer → "API key not found"); optional (omitempty)
    // fields MUST be omitted when unset. symbolID sits at the TOP level.
    const order: Record<string, unknown> = { clOrdID: first.clOrdID };
    order.modifier = first.modifier ?? 1;
    order.side = first.side;
    order.type = first.type;
    order.timeInForce = first.timeInForce;
    if (first.price != null) order.price = dec(first.price);
    if (first.quantity != null) order.quantity = dec(first.quantity);
    if (first.funds != null) order.funds = dec(first.funds);
    if (first.stopPrice != null) order.stopPrice = dec(first.stopPrice);
    if (first.stopType != null) order.stopType = first.stopType;
    if (first.triggerType != null) order.triggerType = first.triggerType;
    order.reduceOnly = first.reduceOnly ?? false;
    order.positionSide = first.positionSide ?? 1;
    const params: Record<string, unknown> = {
      accountID: batch.accountID,
      symbolID: first.symbolID,
      orders: [order],
    };
    // Perps take a batch-level default builder; append LAST, after `orders`.
    if (builderField) params.builder = builderField;
    action = { type: "newOrder", params };
    body = params;
    path = "/trade/orders";
  } else {
    // Spot carries the builder at the batch level, after `orders`.
    const batchBody = builderField
      ? { ...batch, builder: builderField }
      : batch;
    action = { type: "batchNewOrder", params: batchBody };
    body = batchBody;
    path = "/trade/orders/batch";
  }

  const { apiSign, nonce } = await signWithApiKey({
    privateKey,
    domainName: market === "futures" ? "futures" : "spot",
    chainId,
    action,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Sign": apiSign,
    "X-API-Nonce": nonce.toString(),
  };
  if (apiKeyName) headers["X-API-Key"] = apiKeyName;

  // Dev-only payload proof (commit 3a). When NEXT_PUBLIC_SODEX_DRY_RUN=1 —
  // which is guarded to never run in a production build — the order is built
  // and signed exactly as normal, then the FINAL wire payload (body incl. the
  // `builder` fee field, headers incl. X-API-Sign) is logged and a stub
  // returned instead of submitting. Lets us confirm the execute→placeLiveOrder
  // extraction didn't change the payload. The private key is never in the
  // body/headers, so nothing secret is logged.
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.NEXT_PUBLIC_SODEX_DRY_RUN === "1"
  ) {
    // eslint-disable-next-line no-console
    console.log(
      "[DRY_RUN placeOrderBatch]",
      JSON.stringify(
        { url: `${endpoint}${path}`, headers, body },
        // Defensive: mask any field that looks like a secret. The private key
        // is never in headers/body, but this guarantees it (and any seed /
        // mnemonic) can never be logged. X-API-Sign / -Nonce / -Key are not
        // secrets and are left intact.
        (k, v) =>
          /private|secret|seed|mnemonic|passphrase/i.test(k) ? "«redacted»" : v,
        2,
      ),
    );
    return { dryRun: true, orderID: "dry-run", body, headers };
  }

  const res = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await handle<unknown>(res);
  // A per-order REJECTION throws (with SoDEX's reason); "ok"/"unconfirmed" are
  // returned so the caller can distinguish them (see classifyOrderResult).
  if (classifyOrderResult(data).status === "rejected") {
    throw new Error(classifyOrderResult(data).reason ?? "order rejected by SoDEX");
  }
  return data;
}

/**
 * Cancel one or more perps orders — DELETE /trade/orders, signed with the API
 * key as a "cancelOrder" ExchangeAction (the same signing path as newOrder).
 * Each item is {symbolID, orderID}. A cancel has no builder/fee. Supports the
 * same dev-only DRY_RUN flag as placeOrderBatch (logs the final wire payload,
 * masks any secret-looking field, and returns a stub without submitting).
 */
export async function cancelOrders(opts: {
  network: SodexNetwork;
  apiKeyName?: string;
  privateKey: Hex;
  accountID: number;
  cancels: SodexCancelItem[];
  market?: SodexMarket;
}): Promise<unknown> {
  const {
    network,
    apiKeyName,
    privateKey,
    accountID,
    cancels,
    market = "futures",
  } = opts;
  const { chainId, spotEndpoint, perpsEndpoint } = SODEX_NETWORKS[network];
  const endpoint = market === "futures" ? perpsEndpoint : spotEndpoint;

  const params: SodexCancelOrderParams = { accountID, cancels };
  const action: SodexAction<SodexCancelOrderParams> = {
    type: "cancelOrder",
    params,
  };

  const { apiSign, nonce } = await signWithApiKey({
    privateKey,
    domainName: market === "futures" ? "futures" : "spot",
    chainId,
    action,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Sign": apiSign,
    "X-API-Nonce": nonce.toString(),
  };
  if (apiKeyName) headers["X-API-Key"] = apiKeyName;

  const url = `${endpoint}/trade/orders`;

  if (
    process.env.NODE_ENV !== "production" &&
    process.env.NEXT_PUBLIC_SODEX_DRY_RUN === "1"
  ) {
    // eslint-disable-next-line no-console
    console.log(
      "[DRY_RUN cancelOrders]",
      JSON.stringify(
        { method: "DELETE", url, headers, body: params },
        (k, v) =>
          /private|secret|seed|mnemonic|passphrase/i.test(k) ? "«redacted»" : v,
        2,
      ),
    );
    return { dryRun: true, canceled: cancels.length };
  }

  const res = await fetch(url, {
    method: "DELETE",
    headers,
    body: JSON.stringify(params),
  });
  const data = await handle<unknown>(res);
  if (classifyOrderResult(data).status === "rejected") {
    throw new Error(classifyOrderResult(data).reason ?? "cancel rejected by SoDEX");
  }
  return data;
}

/**
 * GET /accounts/{address}/orders — the account's open perps orders.
 * Read-only (no signature). Returns the `orders` array (PerpsOrder shape).
 */
export async function getOpenOrders(
  network: SodexNetwork,
  address: `0x${string}`,
  market: SodexMarket = "futures",
): Promise<SodexOpenOrder[]> {
  const { spotEndpoint, perpsEndpoint } = SODEX_NETWORKS[network];
  const endpoint = market === "futures" ? perpsEndpoint : spotEndpoint;
  const res = await fetch(`${endpoint}/accounts/${address}/orders`);
  const data = await handle<{ orders?: SodexOpenOrder[] }>(res);
  return data?.orders ?? [];
}

/**
 * GET /accounts/{address}/fundings — realized funding payments for the account
 * (most-recent first). Read-only (no signature). `limit` (default 50 upstream)
 * and `symbol` are supported; the response `data` is the array directly.
 */
export async function getAccountFundings(
  network: SodexNetwork,
  address: `0x${string}`,
  opts: { symbol?: string; limit?: number } = {},
  market: SodexMarket = "futures",
): Promise<SodexFundingPayment[]> {
  const { spotEndpoint, perpsEndpoint } = SODEX_NETWORKS[network];
  const endpoint = market === "futures" ? perpsEndpoint : spotEndpoint;
  const qs = new URLSearchParams();
  if (opts.symbol) qs.set("symbol", opts.symbol);
  qs.set("limit", String(opts.limit ?? 100));
  const res = await fetch(`${endpoint}/accounts/${address}/fundings?${qs}`);
  const data = await handle<SodexFundingPayment[]>(res);
  return data ?? [];
}

/** Shared history fetcher — GET /accounts/{address}/{path} with query params,
 *  returning the `data` array (handles `{data:[]}` and `{data:{orders:[]}}`). */
async function fetchAccountList<T>(
  network: SodexNetwork,
  address: `0x${string}`,
  path: string,
  params: Record<string, string | number | undefined>,
  market: SodexMarket,
): Promise<T[]> {
  const { spotEndpoint, perpsEndpoint } = SODEX_NETWORKS[network];
  const endpoint = market === "futures" ? perpsEndpoint : spotEndpoint;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") qs.set(k, String(v));
  }
  const q = qs.toString();
  const res = await fetch(`${endpoint}/accounts/${address}/${path}${q ? `?${q}` : ""}`);
  const data = await handle<T[] | { orders?: T[]; list?: T[] }>(res);
  if (Array.isArray(data)) return data;
  return data?.orders ?? data?.list ?? [];
}

/** GET /accounts/{address}/trades — fills (most-recent first). */
export function getAccountTrades(
  network: SodexNetwork,
  address: `0x${string}`,
  opts: { symbol?: string; limit?: number; startTime?: number; endTime?: number } = {},
  market: SodexMarket = "futures",
): Promise<SodexTrade[]> {
  return fetchAccountList<SodexTrade>(
    network,
    address,
    "trades",
    { limit: opts.limit ?? 100, symbol: opts.symbol, startTime: opts.startTime, endTime: opts.endTime },
    market,
  );
}

/** GET /accounts/{address}/orders/history — filled/cancelled/rejected orders. */
export function getOrderHistory(
  network: SodexNetwork,
  address: `0x${string}`,
  opts: { symbol?: string; limit?: number; startTime?: number; endTime?: number } = {},
  market: SodexMarket = "futures",
): Promise<SodexOrderHistory[]> {
  return fetchAccountList<SodexOrderHistory>(
    network,
    address,
    "orders/history",
    { limit: opts.limit ?? 100, symbol: opts.symbol, startTime: opts.startTime, endTime: opts.endTime },
    market,
  );
}

/** GET /accounts/{address}/positions/history — closed/historical positions. */
export function getPositionsHistory(
  network: SodexNetwork,
  address: `0x${string}`,
  opts: { symbol?: string; limit?: number } = {},
  market: SodexMarket = "futures",
): Promise<SodexClosedPosition[]> {
  return fetchAccountList<SodexClosedPosition>(
    network,
    address,
    "positions/history",
    { limit: opts.limit ?? 100, symbol: opts.symbol },
    market,
  );
}
