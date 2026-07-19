/**
 * DefiLlama emissions (token-unlock) endpoint helpers + pure extraction.
 *
 * Endpoints (all keyless — see client.ts):
 *   GET {DATASETS}/emissionsProtocolsList          → string[] of protocol slugs
 *   GET {DATASETS}/emissions/{slug}                → EmissionsDetail
 *   GET {COINS}/prices/current/{id,id,…}           → { coins: { id: LlamaPrice } }
 *
 * The protocol list is a discovery aid only — it is NOT authoritative for
 * valid emission slugs (e.g. "arbitrum" resolves on /emissions/ but is
 * absent from the list). We therefore drive ingest off the curated
 * UNLOCK_SLUG_BY_TICKER map (verified live) and skip any slug that 404s.
 */

import { env } from "@/lib/env";
import { llamaGet } from "./client";
import type { EmissionsDetail, LlamaPrice, LlamaUnlockEvent } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Curated ticker → DefiLlama protocol slug, for tokens that are BOTH in the
 * Helix universe AND tradable as a SoDEX mainnet perp (so an unlock can be
 * shorted one-click). Every slug below was verified to resolve on
 * /emissions/{slug} on 2026-07-19. Tokens with 0 current upcoming events
 * are still tracked (calendar completeness) and start producing signals as
 * their schedule advances.
 *
 * NOTE the non-obvious slugs: SUI = "sui-foundation" (plain "sui" is empty),
 * OP = "optimism-foundation", AVAX = "avalanche" (token id coingecko:avalanche-2).
 */
export const UNLOCK_SLUG_BY_TICKER: Record<string, string> = {
  APT: "aptos",
  ARB: "arbitrum",
  OP: "optimism-foundation",
  AVAX: "avalanche",
  SUI: "sui-foundation",
  NEAR: "near",
  WLD: "worldcoin",
  ENA: "ethena",
  ONDO: "ondo-finance",
  TAO: "bittensor",
  AXS: "axie-infinity",
  FIL: "filecoin",
  PENGU: "pudgy-penguins",
  PUMP: "pump",
  TRUMP: "official-trump",
  VIRTUAL: "virtuals-protocol",
  TRX: "tron",
  LINK: "chainlink",
  UNI: "uniswap",
  AAVE: "aave",
  HBAR: "hedera",
  SOL: "solana",
};

function datasetsBase(): string {
  return env.DEFILLAMA_DATASETS_URL.replace(/\/$/, "");
}
function coinsBase(): string {
  return env.DEFILLAMA_COINS_URL.replace(/\/$/, "");
}

/** All protocol slugs that have an emission schedule (discovery aid). */
export async function getEmissionsProtocolsList(): Promise<string[]> {
  const list = await llamaGet<unknown>(`${datasetsBase()}/emissionsProtocolsList`);
  return Array.isArray(list) ? (list.filter((s) => typeof s === "string") as string[]) : [];
}

/** Full per-protocol emission schedule + metadata. */
export async function getProtocolEmissions(
  slug: string,
): Promise<EmissionsDetail> {
  return llamaGet<EmissionsDetail>(`${datasetsBase()}/emissions/${slug}`);
}

/** Current USD prices for a set of token ids ("chain:addr" | "coingecko:x"). */
export async function getTokenPrices(
  tokenIds: string[],
): Promise<Record<string, LlamaPrice>> {
  const ids = tokenIds.filter(Boolean);
  if (ids.length === 0) return {};
  const url = `${coinsBase()}/prices/current/${ids.map(encodeURIComponent).join(",")}`;
  const res = await llamaGet<{ coins?: Record<string, LlamaPrice> }>(url);
  return res.coins ?? {};
}

// ─── Pure extraction / computation ───────────────────────────────────────

/** Upcoming events (timestamp in the future), soonest first. */
export function upcomingUnlockEvents(
  detail: EmissionsDetail,
  now = Date.now(),
): LlamaUnlockEvent[] {
  const events = detail.metadata?.unlockEvents ?? [];
  return events
    .filter((e) => Number(e.timestamp) * 1000 > now)
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
}

/** Discrete token amount released by an event (cliff lump). */
export function eventCliffTokens(e: LlamaUnlockEvent): number {
  const fromSummary = Number(e.summary?.totalTokensCliff);
  if (Number.isFinite(fromSummary) && fromSummary > 0) return fromSummary;
  // Fallback: sum cliff allocation amounts.
  return (e.cliffAllocations ?? []).reduce(
    (s, a) => s + (Number.isFinite(Number(a.amount)) ? Number(a.amount) : 0),
    0,
  );
}

/** cliff | linear | mixed, from which allocation arrays are populated. */
export function eventKind(e: LlamaUnlockEvent): "cliff" | "linear" | "mixed" {
  const hasCliff = (e.cliffAllocations ?? []).length > 0;
  const hasLinear = (e.linearAllocations ?? []).length > 0;
  if (hasCliff && hasLinear) return "mixed";
  if (hasLinear) return "linear";
  return "cliff";
}

/** Recipient categories for the event (for bearishness weighting + audit). */
export function eventCategories(
  e: LlamaUnlockEvent,
): Array<{ recipient: string; category: string }> {
  return (e.cliffAllocations ?? []).map((a) => ({
    recipient: a.recipient,
    category: a.category,
  }));
}

/**
 * Circulating supply "now", derived from the cumulative-unlocked series.
 * Sum, over every documentedData tranche whose label is NOT flagged
 * non-circulating, of the latest `unlocked` value at or before `now`.
 * Returns 0 when the series is unavailable (caller falls back to maxSupply).
 */
export function circulatingAtNow(
  detail: EmissionsDetail,
  now = Date.now(),
): number {
  const series = detail.documentedData?.data ?? [];
  const nonCirc = new Set(detail.categories?.noncirculating ?? []);
  const nowSec = now / 1000;
  let total = 0;
  for (const s of series) {
    if (nonCirc.has(s.label)) continue;
    const pts = s.data ?? [];
    let latest = 0;
    for (const p of pts) {
      if (Number(p.timestamp) <= nowSec) {
        const u = Number(p.unlocked);
        if (Number.isFinite(u)) latest = u;
      } else break; // series is time-ordered ascending
    }
    total += latest;
  }
  return total;
}

export const UNLOCK_DAY_MS = DAY_MS;
