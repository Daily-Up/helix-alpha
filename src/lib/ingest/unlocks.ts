/**
 * Token-unlock ingest.
 *
 *   For each curated (ticker → DefiLlama slug):
 *     1. pull /emissions/{slug}          → upcoming unlock events
 *     2. price the token via coins.llama  → USD value of each unlock
 *     3. resolve the SoDEX mainnet perp   → mark shortable rows
 *     4. upsert into token_unlocks (idempotent on "<slug>-<date>")
 *
 * Data source is keyless (DefiLlama datasets CDN). Only cliff (discrete)
 * unlocks become rows — linear vesting is a rate change, not a lump, and
 * doesn't represent a datable sell-pressure event. Idempotent + safe to run
 * daily. The short trade plan (eligibility, entry/cover timing) is derived
 * at read time from each row by lib/unlocks/plan.ts — nothing to "generate".
 */

import { Assets, TokenUnlocks } from "@/lib/db";
import type { NewTokenUnlock } from "@/lib/db";
import { Cron } from "@/lib/db";
import { Unlocks, UNLOCK_SLUG_BY_TICKER } from "@/lib/unlocks";
import type { LlamaPrice } from "@/lib/unlocks";
import { findAsset } from "@/lib/universe";
import { resolveSymbol } from "@/lib/sodex-onchain/client";
import type { SodexNetwork } from "@/lib/sodex-onchain/chains";

export interface UnlocksIngestSummary {
  protocols_processed: number;
  protocols_failed: number;
  events_upserted: number;
  tradable_events: number;
  errors: Array<{ slug: string; error: string }>;
  latency_ms: number;
}

export interface UnlocksIngestOptions {
  /** How far ahead to store unlock events. Default 180 days. */
  horizonDays?: number;
  /** Cap events stored per token (bounds SUI-style weekly schedules). Default 60. */
  maxPerToken?: number;
  /** Throttle between per-protocol fetches (ms). Default 250ms. */
  delayMs?: number;
  /** Restrict to these tickers (testing). */
  onlyTickers?: string[];
  /** Network whose perp catalog decides shortability. Default "mainnet"
   *  (where live execution runs — NOT the testnet DEFAULT_NETWORK). */
  network?: SodexNetwork;
  /** Min price confidence to trust a USD value. Default 0.8. */
  minPriceConfidence?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runUnlocksIngest(
  opts: UnlocksIngestOptions = {},
): Promise<UnlocksIngestSummary> {
  const t0 = Date.now();
  const now = t0;
  const horizonMs = (opts.horizonDays ?? 180) * 24 * 60 * 60 * 1000;
  const maxPerToken = opts.maxPerToken ?? 60;
  const delayMs = opts.delayMs ?? 200;
  const network: SodexNetwork = opts.network ?? "mainnet";
  const minConf = opts.minPriceConfidence ?? 0.8;

  const tickers = Object.keys(UNLOCK_SLUG_BY_TICKER).filter(
    (tk) => !opts.onlyTickers || opts.onlyTickers.includes(tk),
  );

  const errors: UnlocksIngestSummary["errors"] = [];
  let protocolsFailed = 0;
  let eventsUpserted = 0;
  let tradableEvents = 0;

  // Per-protocol fetch → price → upsert, so a mid-run timeout still persists
  // the protocols processed so far (rather than one all-or-nothing batch).
  for (const ticker of tickers) {
    const slug = UNLOCK_SLUG_BY_TICKER[ticker];
    try {
      const detail = await Unlocks.getProtocolEmissions(slug);
      const within = Unlocks.upcomingUnlockEvents(detail, now).filter(
        (e) => Number(e.timestamp) * 1000 <= now + horizonMs,
      );

      const circulating = Unlocks.circulatingAtNow(detail, now);
      const maxSupply = Number(detail.supplyMetrics?.maxSupply) || 0;
      const tokenId = detail.metadata?.token ?? null;

      // Resolve the SoDEX mainnet perp + Helix asset once per token.
      const asset = findAsset(ticker);
      const assetId = asset?.id ?? null;
      const perpSym = `${ticker}-USD`;
      let tradablePerp = false;
      try {
        const meta = await resolveSymbol(network, perpSym);
        tradablePerp = !!meta;
      } catch {
        // Network hiccup — the map is curated to known perps, so assume
        // tradable rather than dropping a real shortable unlock.
        tradablePerp = true;
      }
      // Ensure the asset row exists so the signal FK + render join resolve.
      if (asset && tradablePerp) {
        try {
          await Assets.upsertAsset(asset);
        } catch {
          /* non-fatal — seed step owns this normally */
        }
      }

      // Price this token (single id).
      let price: number | null = null;
      if (tokenId) {
        try {
          const priced: Record<string, LlamaPrice> =
            await Unlocks.getTokenPrices([tokenId]);
          const p = priced[tokenId];
          if (p && Number.isFinite(p.price) && p.confidence >= minConf) {
            price = p.price;
          }
        } catch (err) {
          errors.push({ slug: `${slug}:price`, error: (err as Error).message });
        }
      }

      const rows: NewTokenUnlock[] = within
        .map((e) => ({
          tokens: Unlocks.eventCliffTokens(e),
          unlock_at: Number(e.timestamp) * 1000,
          unlock_date: new Date(Number(e.timestamp) * 1000)
            .toISOString()
            .slice(0, 10),
          kind: Unlocks.eventKind(e),
          categories: Unlocks.eventCategories(e),
        }))
        .filter((e) => Number.isFinite(e.tokens) && e.tokens > 0)
        .slice(0, maxPerToken)
        .map((e) => {
          const usd = price != null ? e.tokens * price : null;
          return {
            id: `${slug}-${e.unlock_date}`,
            protocol_slug: slug,
            token_id: tokenId,
            symbol: ticker,
            asset_id: assetId,
            sodex_symbol: tradablePerp ? perpSym : null,
            tradable_perp: tradablePerp ? 1 : 0,
            unlock_at: e.unlock_at,
            unlock_date: e.unlock_date,
            unlock_kind: e.kind,
            tokens_unlocked: e.tokens,
            unlock_value_usd: usd,
            price_usd: price,
            pct_of_circulating:
              circulating > 0 ? (100 * e.tokens) / circulating : null,
            pct_of_max_supply:
              maxSupply > 0 ? (100 * e.tokens) / maxSupply : null,
            categories_json: JSON.stringify(e.categories),
            source: "defillama",
            raw_json: JSON.stringify({
              slug,
              tokens: e.tokens,
              kind: e.kind,
              categories: e.categories,
            }),
          } satisfies NewTokenUnlock;
        });

      await TokenUnlocks.upsertUnlocks(rows);
      eventsUpserted += rows.length;
      if (tradablePerp) tradableEvents += rows.length;
    } catch (err) {
      protocolsFailed++;
      errors.push({ slug, error: (err as Error).message ?? String(err) });
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    protocols_processed: tickers.length,
    protocols_failed: protocolsFailed,
    events_upserted: eventsUpserted,
    tradable_events: tradableEvents,
    errors,
    latency_ms: Date.now() - t0,
  };
}

export async function runUnlocksIngestWithAudit(
  opts: UnlocksIngestOptions = {},
): Promise<UnlocksIngestSummary & { run_id: number }> {
  const { id, data } = await Cron.recordRun("ingest_unlocks", async () => {
    const summary = await runUnlocksIngest(opts);
    const text =
      `protocols=${summary.protocols_processed} ` +
      `(failed=${summary.protocols_failed}) ` +
      `events=${summary.events_upserted} (tradable=${summary.tradable_events}) ` +
      `latency=${(summary.latency_ms / 1000).toFixed(1)}s`;
    return { summary: text, data: summary };
  });
  return { ...(data as UnlocksIngestSummary), run_id: id };
}
