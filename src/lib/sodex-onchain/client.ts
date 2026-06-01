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
  error?: string;
}

/**
 * Look up SoDEX's numeric `symbolID` for a textual spot symbol.
 *
 * SoDEX assigns each market a numeric ID; the trading API expects
 * that integer, not the human-readable symbol. We fetch the catalog
 * once from /trade/symbols and memoize per network.
 */
const _symbolMapCache = new Map<SodexNetwork, Map<string, number>>();
export async function getSymbolId(
  network: SodexNetwork,
  symbol: string,
): Promise<number | undefined> {
  const norm = symbol.toUpperCase();
  let map = _symbolMapCache.get(network);
  if (!map) {
    map = new Map();
    try {
      const { spotEndpoint } = SODEX_NETWORKS[network];
      const res = await fetch(`${spotEndpoint}/trade/symbols`);
      const json = (await res.json()) as {
        code: number;
        data?: Array<{ id?: number; symbol?: string; name?: string }>;
      };
      if (json.code === 0 && json.data) {
        for (const s of json.data) {
          const id = s.id;
          const key = (s.symbol ?? s.name ?? "").toUpperCase();
          if (id != null && key) map.set(key, id);
        }
      }
    } catch {
      /* fall back to empty map; caller will get undefined */
    }
    _symbolMapCache.set(network, map);
  }
  return map.get(norm);
}

// ── Testnet faucet ─────────────────────────────────────────────────

const TESTNET_FAUCET_BASE = "https://alpha-biz.sodex.dev/faucet/api";

export interface FaucetClaimResult {
  ok: boolean;
  /** "claim success" on success; otherwise the gateway-side error. */
  message: string;
  /** When this address last drained the faucet, if returned. */
  lastClaimedAt?: number;
}

/**
 * Trigger the SoDEX testnet faucet for the given address. Open CORS,
 * so we call straight from the browser — Helix's server is not in
 * the path. The faucet drips 100 vUSDC per address per day; repeated
 * calls within the same window return a "claim limit" error which
 * we surface verbatim.
 */
export async function claimTestnetFaucet(
  address: `0x${string}`,
): Promise<FaucetClaimResult> {
  try {
    const res = await fetch(`${TESTNET_FAUCET_BASE}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    const json = (await res.json()) as {
      code: number;
      msg: string;
      data?: unknown;
    };
    if (json.code === 0) {
      return { ok: true, message: String(json.data ?? "claim success") };
    }
    return { ok: false, message: json.msg || `code ${json.code}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/**
 * Check whether an address is allowed to claim from the faucet.
 * Useful for telling the user "you've already claimed today" before
 * we even attempt the call.
 */
export interface FaucetWhitelistStatus {
  inWhitelist: boolean;
  inAnotherWhitelist: boolean;
  claimFlag: boolean;
  claimStatus: number;
  claimCount: number;
}
export async function checkFaucetWhitelist(
  address: `0x${string}`,
): Promise<FaucetWhitelistStatus | null> {
  try {
    const res = await fetch(`${TESTNET_FAUCET_BASE}/check-whitelist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    const json = (await res.json()) as {
      code: number;
      data?: FaucetWhitelistStatus;
    };
    if (json.code === 0 && json.data) return json.data;
    return null;
  } catch {
    return null;
  }
}

async function handle<T>(res: Response): Promise<T> {
  const json = (await res.json()) as SodexResponse<T>;
  if (json.code !== 0) {
    throw new Error(json.error ?? `SoDEX error code ${json.code}`);
  }
  if (json.data === undefined) {
    throw new Error("SoDEX response missing data");
  }
  return json.data;
}

/** GET /accounts/{address}/state — returns account ID + balances. */
export async function getAccountState(
  network: SodexNetwork,
  address: `0x${string}`,
): Promise<SodexAccountState> {
  const { spotEndpoint } = SODEX_NETWORKS[network];
  const res = await fetch(`${spotEndpoint}/accounts/${address}/state`);
  return handle<SodexAccountState>(res);
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
  const { chainId, spotEndpoint } = SODEX_NETWORKS[network];

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

  const res = await fetch(`${spotEndpoint}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await handle<unknown>(res);
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
}): Promise<unknown> {
  const { network, apiKeyName, privateKey, batch } = opts;
  const { chainId, spotEndpoint } = SODEX_NETWORKS[network];

  const action: SodexAction<SodexNewOrderBatch> = {
    type: "newOrder",
    params: batch,
  };

  const { apiSign, nonce } = await signWithApiKey({
    privateKey,
    domainName: "spot",
    chainId,
    action,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Sign": apiSign,
    "X-API-Nonce": nonce.toString(),
  };
  if (apiKeyName) headers["X-API-Key"] = apiKeyName;

  const res = await fetch(`${spotEndpoint}/trade/orders/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify(batch),
  });
  return handle<unknown>(res);
}
