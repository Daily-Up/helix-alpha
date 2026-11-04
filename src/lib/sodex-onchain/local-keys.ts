/**
 * Local trading-identity storage.
 *
 * For each SoDEX network the user has ONE active trading identity,
 * stored only in their browser:
 *
 *   helix.sodex.identity.<network>  →  StoredApiKey { name, privateKey,
 *                                                    address, createdAt }
 *
 * Two ways to populate this slot:
 *
 *   - "Burner" — generate keypair locally, no master wallet, no
 *     SoDEX-side addAPIKey registration. `name` is the empty string.
 *     The wallet IS the trading identity (Hyperliquid-style flow,
 *     and what SoDEX uses on testnet).
 *
 *   - "Master + API key" — connect a master wallet via wagmi,
 *     generate a fresh keypair, sign `addAPIKey` to register the
 *     public address with SoDEX, store the private key + the
 *     registered `name`. Order signing then includes the X-API-Key
 *     header. This is the recommended mainnet flow.
 *
 * Safety limits also live per-network so a judge can flip between
 * testnet and mainnet without losing their limits.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { SodexNetwork } from "./chains";

const IDENTITY_PREFIX = "helix.sodex.identity";

export interface StoredApiKey {
  /** SoDEX-registered API-key name, or "" for a burner wallet. */
  name: string;
  /** secp256k1 private key. Secret — never sent to Helix's server. */
  privateKey: Hex;
  /** Public address derived from the private key. The API key's OWN
   *  address — SoDEX uses this to verify order signatures, but it
   *  doesn't own a SoDEX account itself. */
  address: `0x${string}`;
  /** Master wallet that signed addAPIKey — the address that actually
   *  owns the SoDEX account whose `aid` we trade against. Optional on
   *  legacy keys (burner flow had no master); when absent the order
   *  flow falls back to the API-key address (works for burner only).
   *  NEVER write the master's PRIVATE key here; we only need the
   *  public address for account-state lookups. */
  masterAddress?: `0x${string}`;
  /** Local timestamp of creation. */
  createdAt: number;
}

function identityKey(network: SodexNetwork): string {
  return `${IDENTITY_PREFIX}.${network}`;
}

export function readLocalKey(network: SodexNetwork): StoredApiKey | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(identityKey(network));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredApiKey;
  } catch {
    return null;
  }
}

export function writeLocalKey(
  network: SodexNetwork,
  key: StoredApiKey,
): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(identityKey(network), JSON.stringify(key));
}

export function clearLocalKey(network: SodexNetwork): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(identityKey(network));
}

/**
 * Mint a fresh keypair for the master+API-key flow. The caller is
 * expected to call `addAPIKey` on SoDEX with the returned `.address`,
 * THEN persist via `writeLocalKey`.
 */
export function mintNewApiKey(name: string): StoredApiKey {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return {
    name,
    privateKey,
    address: account.address,
    createdAt: Date.now(),
  };
}

/** Generate a name like "helix-bot-a3f2". */
export function suggestKeyName(prefix = "helix"): string {
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${suffix}`;
}

// ─── API-key expiry (master + API-key flow) ─────────────────────────
// Registered keys are minted with a 7-day SoDEX expiry (the default in
// client.ts `addApiKey`). We don't persist the expiry in StoredApiKey —
// it's always createdAt + this TTL — so the order form can check it with
// no network call. Burner keys (name === "") are the wallet itself and
// never expire this way.
export const SODEX_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// When less than this is left (or it's already past), prompt the user to
// re-authorize before a trade silently fails at the gateway on a dead key.
export const SODEX_KEY_EXPIRING_MS = 12 * 60 * 60 * 1000;

export type KeyExpiryState = "active" | "expiring" | "expired" | "none";

export interface KeyExpiry {
  /** Unix-ms expiry, or null when the key doesn't expire (burner / "0"). */
  expiresAt: number | null;
  /** Ms until expiry (negative once expired), or null. */
  msLeft: number | null;
  state: KeyExpiryState;
}

const NO_EXPIRY: KeyExpiry = { expiresAt: null, msLeft: null, state: "none" };

/** Expiry view for a locally-stored key (createdAt + 7-day TTL). */
export function localKeyExpiry(
  key: StoredApiKey,
  now: number = Date.now(),
): KeyExpiry {
  if (!key.name) return NO_EXPIRY; // burner wallet — no registration to expire
  return expiryFromTimestamp(key.createdAt + SODEX_KEY_TTL_MS, now);
}

/**
 * Expiry view from an absolute expiry timestamp — e.g. SoDEX's
 * `listApiKeys` value, where 0 means "no expiry". Defensive about units:
 * a value below 1e12 is treated as Unix-seconds and scaled to ms (a real
 * near-future ms timestamp is ~1.7e12), so we render correctly whether
 * the gateway echoes ms or seconds.
 */
export function expiryFromTimestamp(
  expiresAt: number,
  now: number = Date.now(),
): KeyExpiry {
  if (!expiresAt || expiresAt <= 0) return NO_EXPIRY;
  const ms = expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  const msLeft = ms - now;
  const state: KeyExpiryState =
    msLeft <= 0
      ? "expired"
      : msLeft <= SODEX_KEY_EXPIRING_MS
        ? "expiring"
        : "active";
  return { expiresAt: ms, msLeft, state };
}

/** Human label: "expires in 3d 4h", "expires in 11h 20m", "expired", or "". */
export function formatExpiry(e: KeyExpiry): string {
  if (e.state === "none" || e.msLeft == null) return "";
  if (e.msLeft <= 0) return "expired";
  const totalMin = Math.floor(e.msLeft / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `expires in ${d}d ${h}h`;
  if (h > 0) return `expires in ${h}h ${m}m`;
  return `expires in ${m}m`;
}

// ─── SoDEX minimum notional ──────────────────────────────────────────
/** SoDEX's minimum notional is ~$10 across pairs; orders below this are
 *  rejected at the gateway, so we refuse client-side with a clear msg. */
export const SODEX_MIN_NOTIONAL_USD = 10;

// ─── Risk-acceptance (one-time, per browser) ────────────────────────
// The SodexAuth setup modal's final step. Stored per network so the
// "ready" state can be re-derived without re-prompting each visit.

const DISCLAIMER_PREFIX = "helix.sodex.disclaimer";

export function readDisclaimerAccepted(network: SodexNetwork): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(`${DISCLAIMER_PREFIX}.${network}`) === "1";
  } catch {
    return false;
  }
}

export function writeDisclaimerAccepted(
  network: SodexNetwork,
  accepted: boolean,
): void {
  if (typeof window === "undefined") return;
  try {
    const k = `${DISCLAIMER_PREFIX}.${network}`;
    if (accepted) window.localStorage.setItem(k, "1");
    else window.localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

