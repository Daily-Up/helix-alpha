/**
 * Event-impact engine.
 *
 * For each (event, affected_asset) row that doesn't yet have an
 * impact_metrics row, look up the asset's daily closing prices around
 * the event timestamp and compute the percentage change at T+1d, T+3d,
 * and T+7d horizons.
 *
 * Algorithm:
 *   1. event happens at release_time (ms)
 *   2. T+0  = close on or before the event's UTC date — the anchor price
 *   3. T+Nd = close N trading days *after* T+0
 *   4. impact_pct_Nd = (price_TNd - price_T0) / price_T0 * 100
 *
 * Limitations (acknowledged):
 *   • Klines are 1d only, so we can't measure intra-day moves
 *   • Weekends and crypto-only assets that don't have daily candles for
 *     a given date will be approximated by the next-available close
 *   • If T+7d is in the future (event was <7 days ago) we leave that
 *     horizon NULL and the engine will fill it on a later run
 */

import { Cron, db, Impact } from "@/lib/db";
import { formatApiDate } from "@/lib/sosovalue";

interface PriceRow {
  asset_id: string;
  date: string;
  close: number;
}

/** Pull all klines for an asset into a date→close map. */
function loadCloses(assetId: string): Map<string, number> {
  const rows = db()
    .prepare<[string], PriceRow>(
      `SELECT asset_id, date, close
       FROM klines_daily
       WHERE asset_id = ?
       ORDER BY date ASC`,
    )
    .all(assetId);
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.date, r.close);
  return m;
}

/**
 * Find the close price on or before `targetDate`. Walks back up to 7 days
 * to handle weekends / data gaps before giving up.
 */
function priceOnOrBefore(
  closes: Map<string, number>,
  targetDate: string,
): number | null {
  const d = new Date(`${targetDate}T00:00:00Z`);
  for (let i = 0; i < 7; i++) {
    const key = formatApiDate(d.getTime());
    const v = closes.get(key);
    if (v != null) return v;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return null;
}

/** Add `days` to a YYYY-MM-DD string and return the new YYYY-MM-DD. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return formatApiDate(d.getTime());
}

export interface ImpactComputeSummary {
  pending: number;
  computed: number;
  skipped_no_t0: number;
  skipped_no_klines: number;
  errors: number;
  latency_ms: number;
}

export interface ImpactComputeOptions {
  /** Max event-asset pairs to process per run. */
  limit?: number;
}

export async function runImpactCompute(
  opts: ImpactComputeOptions = {},
): Promise<ImpactComputeSummary> {
  const t0 = Date.now();
  const limit = opts.limit ?? 500;

  const pending = Impact.getPendingImpactEvents(limit);

  // Group by asset_id so we load each asset's klines into memory once.
  const byAsset = new Map<string, typeof pending>();
  for (const p of pending) {
    if (!byAsset.has(p.asset_id)) byAsset.set(p.asset_id, []);
    byAsset.get(p.asset_id)!.push(p);
  }

  let computed = 0;
  let skippedNoT0 = 0;
  let skippedNoKlines = 0;
  let errors = 0;

  for (const [assetId, items] of byAsset) {
    const closes = loadCloses(assetId);
    if (closes.size === 0) {
      skippedNoKlines += items.length;
      continue;
    }

    for (const it of items) {
      try {
        // Snap event to its UTC date.
        const eventDate = formatApiDate(it.release_time);
        const t0Price = priceOnOrBefore(closes, eventDate);

        if (t0Price == null) {
          skippedNoT0++;
          continue;
        }

        // For each horizon, compute (price_target - t0) / t0
        const t1Date = addDays(eventDate, 1);
        const t3Date = addDays(eventDate, 3);
        const t7Date = addDays(eventDate, 7);

        const today = formatApiDate(Date.now());
        // Strict comparison: the target date must be in the PAST (not equal
        // to today, since today's daily candle isn't closed yet). Without
        // this we'd compare event-day close to itself.
        const t1Final = t1Date < today ? priceOnOrBefore(closes, t1Date) : null;
        const t3Final = t3Date < today ? priceOnOrBefore(closes, t3Date) : null;
        const t7Final = t7Date < today ? priceOnOrBefore(closes, t7Date) : null;

        // Sanity: only insert if at least one horizon is measurable.
        // Skipping pure-null rows keeps impact_metrics meaningful and
        // means a re-run tomorrow will pick up what's now measurable.
        if (t1Final == null && t3Final == null && t7Final == null) {
          continue;
        }

        const pct = (later: number | null) =>
          later != null && t0Price > 0
            ? ((later - t0Price) / t0Price) * 100
            : null;

        Impact.upsertImpact({
          event_id: it.event_id,
          asset_id: it.asset_id,
          price_t0: t0Price,
          price_t1d: t1Final,
          price_t3d: t3Final,
          price_t7d: t7Final,
          impact_pct_1d: pct(t1Final),
          impact_pct_3d: pct(t3Final),
          impact_pct_7d: pct(t7Final),
        });
        computed++;
      } catch {
        errors++;
      }
    }
  }

  return {
    pending: pending.length,
    computed,
    skipped_no_t0: skippedNoT0,
    skipped_no_klines: skippedNoKlines,
    errors,
    latency_ms: Date.now() - t0,
  };
}

export async function runImpactComputeWithAudit(
  opts: ImpactComputeOptions = {},
): Promise<ImpactComputeSummary & { run_id: number }> {
  const { id, data } = await Cron.recordRun("compute_impact", async () => {
    const summary = await runImpactCompute(opts);
    return {
      summary:
        `pending=${summary.pending} computed=${summary.computed} ` +
        `skip_no_t0=${summary.skipped_no_t0} skip_no_klines=${summary.skipped_no_klines}`,
      data: summary,
    };
  });
  return { ...(data as ImpactComputeSummary), run_id: id };
}
