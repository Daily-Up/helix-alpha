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
import { SODEX_NETWORKS, type SodexNetwork } from "./chains";
import {
  signAddAPIKeyAction,
  signWithApiKey,
  signWithMasterWallet,
  type Eip1193Provider,
} from "./signing";
import type {
  SodexAccountState,
  SodexAction,
  SodexAddApiKeyParams,
  SodexApiKeyRow,
  SodexNewOrderBatch,
  SodexRevokeApiKeyParams,
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
    // EXACT perps NewOrderParams shape from the SoDEX docs:
    //   {accountID, symbolID, orders:[{clOrdID, modifier, side, type,
    //    timeInForce, quantity, reduceOnly, positionSide}]}
    // symbolID sits at the TOP level (not per-order). Field ORDER is
    // load-bearing: the gateway re-hashes the marshaled struct, so a wrong
    // order → wrong recovered signer → "API key not found". Every order flag
    // (modifier=NORMAL 1, reduceOnly=false, positionSide=BOTH 1) must be
    // present, even at zero.
    const order = {
      clOrdID: first.clOrdID,
      modifier: first.modifier ?? 1,
      side: first.side,
      type: first.type,
      timeInForce: first.timeInForce,
      quantity: first.quantity,
      reduceOnly: first.reduceOnly ?? false,
      positionSide: first.positionSide ?? 1,
    };
    const params = {
      accountID: batch.accountID,
      symbolID: first.symbolID,
      orders: [order],
    };
    action = { type: "newOrder", params };
    body = params;
    path = "/trade/orders";
  } else {
    action = { type: "batchNewOrder", params: batch };
    body = batch;
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

  const res = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return handle<unknown>(res);
}
