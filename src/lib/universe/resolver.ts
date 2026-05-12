/**
 * Resolver — maps the universe's logical symbols to SoSoValue's
 * `currency_id` snowflake IDs by hitting /currencies once and caching.
 *
 * The cache is process-local + has a TTL so it refreshes gracefully when
 * SoSoValue adds new tokens. In production we run resolveAll() inside
 * the daily cron and persist the result to the database.
 */

import { Currencies } from "@/lib/sosovalue";
import type { Asset } from "./types";

interface CacheEntry {
  bySymbol: Map<string, string>; // lowercase symbol -> currency_id
  byId: Map<string, { symbol: string; name: string }>;
  fetchedAt: number;
}

const TTL_MS = 60 * 60 * 1000; // 1 hour
let cache: CacheEntry | null = null;

async function loadCache(force = false): Promise<CacheEntry> {
  if (!force && cache && Date.now() - cache.fetchedAt < TTL_MS) {
    return cache;
  }
  const all = await Currencies.getCurrencies();
  const bySymbol = new Map<string, string>();
  const byId = new Map<string, { symbol: string; name: string }>();
  for (const c of all) {
    if (c.symbol && c.currency_id) {
      bySymbol.set(c.symbol.toLowerCase(), c.currency_id);
      byId.set(c.currency_id, { symbol: c.symbol, name: c.name });
    }
  }
  cache = { bySymbol, byId, fetchedAt: Date.now() };
  return cache;
}

/** Resolve a symbol (case-insensitive) to its SoSoValue currency_id. */
export async function resolveCurrencyId(
  symbol: string,
): Promise<string | undefined> {
  const c = await loadCache();
  return c.bySymbol.get(symbol.toLowerCase());
}

/** Reverse: symbol/name from a currency_id. */
export async function lookupCurrency(
  currencyId: string,
): Promise<{ symbol: string; name: string } | undefined> {
  const c = await loadCache();
  return c.byId.get(currencyId);
}

/** Force-refresh and return the full cache. */
export function refreshCurrencyCache(): Promise<CacheEntry> {
  return loadCache(true);
}

/**
 * Resolve every token/RWA asset in a universe — fills in `currency_id`
 * on the routing object and returns the fully-resolved list. Assets
 * whose symbol can't be matched are dropped with a warning.
 */
export async function resolveUniverse(universe: Asset[]): Promise<Asset[]> {
  const c = await loadCache();
  const out: Asset[] = [];
  for (const a of universe) {
    if (a.sosovalue.kind === "token" || a.sosovalue.kind === "rwa") {
      const id = c.bySymbol.get(a.sosovalue.symbol.toLowerCase());
      if (!id) {
        // Asset isn't in SoSoValue yet — skip with a console warning.
        // (Not throwing because we don't want one missing token to break ingest.)
        console.warn(
          `[universe] could not resolve ${a.symbol} on SoSoValue; skipping`,
        );
        continue;
      }
      out.push({
        ...a,
        sosovalue: { ...a.sosovalue, currency_id: id },
      });
    } else {
      out.push(a);
    }
  }
  return out;
}
