/**
 * Klines ingest — pulls daily OHLCV for every token/RWA in the universe
 * and upserts into klines_daily.
 *
 * Constraints:
 *   • SoSoValue klines are 1d only, last ~3 months
 *   • We pull up to 90 days per asset on each run (idempotent upsert)
 *   • Sequentially, with a small delay between calls so we don't get
 *     rate-limited on free tiers.
 */

import { Assets, Cron, Klines } from "@/lib/db";
import { Currencies, CryptoStocks } from "@/lib/sosovalue";
import type { Asset } from "@/lib/universe";

export interface KlinesIngestSummary {
  assets_processed: number;
  assets_failed: number;
  candles_upserted: number;
  /** Per-asset-class breakdown so the audit log shows what got pulled. */
  by_kind: Record<string, { processed: number; candles: number; failed: number }>;
  errors: Array<{ asset_id: string; error: string }>;
  latency_ms: number;
}

export interface KlinesIngestOptions {
  /** How many recent days per asset (max 90 — API ceiling). */
  daysBack?: number;
  /** Throttle between calls in ms (default 200ms). */
  delayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pull klines for every token, RWA, AND stock asset. Each kind goes
 * through its own SoSoValue endpoint:
 *   • tokens / RWAs → /currencies/{currency_id}/klines
 *   • stocks         → /crypto-stocks/{ticker}/klines
 * ETFs / indexes / macro have separate endpoints with different shapes
 * and are handled elsewhere — they don't feed `klines_daily`.
 *
 * Without stock klines, impact_metrics can't measure crypto-stock
 * signals (NVDA, COIN, MSTR, …) which silently breaks the /learnings
 * coverage and the AlphaIndex tilt logic for stock holdings.
 */
export async function runKlinesIngest(
  opts: KlinesIngestOptions = {},
): Promise<KlinesIngestSummary> {
  const t0 = Date.now();
  const daysBack = Math.min(90, Math.max(1, opts.daysBack ?? 90));
  const delayMs = opts.delayMs ?? 600;

  const all = Assets.getAllAssets();
  const targets: Asset[] = all.filter(
    (a) => a.kind === "token" || a.kind === "rwa" || a.kind === "stock",
  );

  let candles = 0;
  let failed = 0;
  const errors: KlinesIngestSummary["errors"] = [];
  const by_kind: KlinesIngestSummary["by_kind"] = {};
  const tally = (kind: string, c: number, ok: boolean) => {
    by_kind[kind] ??= { processed: 0, candles: 0, failed: 0 };
    by_kind[kind].processed += 1;
    by_kind[kind].candles += c;
    if (!ok) by_kind[kind].failed += 1;
  };

  for (const asset of targets) {
    try {
      let klines: Awaited<ReturnType<typeof Currencies.getDailyKlines>> = [];

      if (
        asset.sosovalue.kind === "token" ||
        asset.sosovalue.kind === "rwa"
      ) {
        const cid = asset.sosovalue.currency_id;
        if (!cid) continue;
        klines = await Currencies.getDailyKlines(cid, daysBack);
      } else if (asset.sosovalue.kind === "stock") {
        const limit = Math.min(500, Math.max(1, daysBack));
        // The crypto-stocks endpoint returns the same Kline shape (timestamp,
        // open, high, low, close, volume) — confirmed via the inspect script.
        klines = await CryptoStocks.getCryptoStockKlines(
          asset.sosovalue.ticker,
          { interval: "1d", limit },
        );
      } else {
        // Treasuries / ETFs / indexes / macro — not handled here.
        continue;
      }

      const upserted = Klines.upsertKlines(asset.id, klines);
      candles += upserted;
      tally(asset.kind, upserted, true);
    } catch (err) {
      failed++;
      tally(asset.kind, 0, false);
      errors.push({
        asset_id: asset.id,
        error: (err as Error).message ?? String(err),
      });
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    assets_processed: targets.length,
    assets_failed: failed,
    candles_upserted: candles,
    by_kind,
    errors,
    latency_ms: Date.now() - t0,
  };
}

export async function runKlinesIngestWithAudit(
  opts: KlinesIngestOptions = {},
): Promise<KlinesIngestSummary & { run_id: number }> {
  const { id, data } = await Cron.recordRun("ingest_klines", async () => {
    const summary = await runKlinesIngest(opts);
    const breakdown = Object.entries(summary.by_kind)
      .map(([k, v]) => `${k}:${v.processed}(${v.candles}c)`)
      .join(" ");
    const text =
      `assets=${summary.assets_processed} candles=${summary.candles_upserted} ` +
      `failed=${summary.assets_failed} ${breakdown} ` +
      `latency=${(summary.latency_ms / 1000).toFixed(1)}s`;
    return { summary: text, data: summary };
  });
  return { ...(data as KlinesIngestSummary), run_id: id };
}
