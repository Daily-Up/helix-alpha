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
const LIMITS_PREFIX = "helix.sodex.limits";

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

// ─── Safety limits (per-network) ────────────────────────────────────

export interface SafetyLimits {
  maxPositionUsd: number;
  maxDailyTrades: number;
  acceptedDisclaimer: boolean;
}

const DEFAULT_LIMITS: SafetyLimits = {
  maxPositionUsd: 10,
  maxDailyTrades: 3,
  acceptedDisclaimer: false,
};

function limitsKey(network: SodexNetwork): string {
  return `${LIMITS_PREFIX}.${network}`;
}

export function readSafetyLimits(network: SodexNetwork): SafetyLimits {
  if (typeof window === "undefined") return DEFAULT_LIMITS;
  const raw = window.localStorage.getItem(limitsKey(network));
  if (!raw) return DEFAULT_LIMITS;
  try {
    return { ...DEFAULT_LIMITS, ...(JSON.parse(raw) as Partial<SafetyLimits>) };
  } catch {
    return DEFAULT_LIMITS;
  }
}

export function writeSafetyLimits(
  network: SodexNetwork,
  limits: SafetyLimits,
): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(limitsKey(network), JSON.stringify(limits));
}
