/**
 * Classify SoDEX API keys returned by `listApiKeys`.
 *
 * SoDEX auto-creates two well-known keys for every account that we do
 * NOT want to treat as user-controllable trading keys:
 *
 *   - `default` — the master wallet itself. Cannot be revoked. SoDEX
 *     uses it as the signing authority for governance actions
 *     (addAPIKey / revokeAPIKey). It's not a Helix-trading key.
 *   - `web`    — automatically registered when a user signs into the
 *     official SoDEX web UI at sodex.com. Lives in their browser, not
 *     ours, and is irrelevant to Helix execution. From our perspective
 *     a user with only a `web` key has NOT yet set up a Helix trading
 *     identity and should see the "create one" CTA.
 *
 * Any key whose `name` starts with `helix-` is one we minted via the
 * /settings/connect-sodex wizard. Everything else (third-party trading
 * bots the user might have, custom names) is "user external."
 *
 * The 5-keys-per-account cap is enforced server-side by SoDEX and
 * counts EVERY key including system ones, so we surface both totals
 * to the user.
 */

import type { SodexApiKeyRow } from "./types";

const SYSTEM_KEY_NAMES = new Set<string>(["default", "web"]);
const HELIX_KEY_PREFIX = "helix-";

export type KeyRole = "system" | "helix" | "external";

/** Classify a single key row. */
export function classifyKey(name: string): KeyRole {
  if (SYSTEM_KEY_NAMES.has(name)) return "system";
  if (name.startsWith(HELIX_KEY_PREFIX)) return "helix";
  return "external";
}

/** True if this key is a SoDEX-managed system key (default / web). */
export function isSystemKey(name: string): boolean {
  return SYSTEM_KEY_NAMES.has(name);
}

/** True if this key was minted by Helix (`helix-…`). */
export function isHelixManagedKey(name: string): boolean {
  return name.startsWith(HELIX_KEY_PREFIX);
}

/**
 * Drop system keys (`default`, `web`) from a key list — what we show
 * the user as "your Helix-usable keys."
 */
export function userManagedKeys(keys: SodexApiKeyRow[]): SodexApiKeyRow[] {
  return keys.filter((k) => !isSystemKey(k.name));
}

/** Inverse of `userManagedKeys` — the system keys we hide from the
 *  main list but mention separately so users understand the 5-cap. */
export function systemKeys(keys: SodexApiKeyRow[]): SodexApiKeyRow[] {
  return keys.filter((k) => isSystemKey(k.name));
}

/**
 * True if the user has at least one Helix-managed key registered
 * on SoDEX. Used for the "have they set up Helix execution at all?"
 * decision — ignores `web` and `default`.
 */
export function hasHelixKey(keys: SodexApiKeyRow[]): boolean {
  return keys.some((k) => isHelixManagedKey(k.name));
}
