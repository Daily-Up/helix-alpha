/**
 * Local API-key storage.
 *
 * Browser localStorage is the ONLY home for the API key's private key.
 * It never crosses to Helix's server. Each user/wallet/network gets
 * its own key under a distinct storage slot.
 *
 * Layout:
 *   helix.sodex.keys.<network>.<wallet> -> { name, privateKey, address, createdAt }
 *
 * We deliberately don't sync these across devices or back them up.
 * If the user wipes their browser data, they can re-issue a new key
 * (max 5 per account) without any loss of funds.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { SodexNetwork } from "./chains";

const KEY_PREFIX = "helix.sodex.keys";

export interface StoredApiKey {
  /** Human-readable name registered on SoDEX (max 36 chars, /^[0-9a-zA-Z_-]+$/) */
  name: string;
  /** secp256k1 private key — secret, never sent over the wire. */
  privateKey: Hex;
  /** Public address derived from the private key (sent during addAPIKey). */
  address: `0x${string}`;
  /** Local timestamp of creation. */
  createdAt: number;
}

function storageKey(network: SodexNetwork, wallet: `0x${string}`): string {
  return `${KEY_PREFIX}.${network}.${wallet.toLowerCase()}`;
}

export function readLocalKey(
  network: SodexNetwork,
  wallet: `0x${string}`,
): StoredApiKey | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(storageKey(network, wallet));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredApiKey;
  } catch {
    return null;
  }
}

export function writeLocalKey(
  network: SodexNetwork,
  wallet: `0x${string}`,
  key: StoredApiKey,
): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storageKey(network, wallet), JSON.stringify(key));
}

export function clearLocalKey(
  network: SodexNetwork,
  wallet: `0x${string}`,
): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(storageKey(network, wallet));
}

/**
 * Mint a brand-new API keypair locally. The private key never leaves
 * this function's return value — the page component is responsible
 * for shipping ONLY the public address to SoDEX via addAPIKey, and
 * then persisting the StoredApiKey via writeLocalKey.
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

// ─── Safety limits ─────────────────────────────────────────────────

const LIMITS_PREFIX = "helix.sodex.limits";

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

function limitsKey(wallet: `0x${string}`): string {
  return `${LIMITS_PREFIX}.${wallet.toLowerCase()}`;
}

export function readSafetyLimits(wallet: `0x${string}`): SafetyLimits {
  if (typeof window === "undefined") return DEFAULT_LIMITS;
  const raw = window.localStorage.getItem(limitsKey(wallet));
  if (!raw) return DEFAULT_LIMITS;
  try {
    return { ...DEFAULT_LIMITS, ...(JSON.parse(raw) as Partial<SafetyLimits>) };
  } catch {
    return DEFAULT_LIMITS;
  }
}

export function writeSafetyLimits(
  wallet: `0x${string}`,
  limits: SafetyLimits,
): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(limitsKey(wallet), JSON.stringify(limits));
}
