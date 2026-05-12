/**
 * Empirical pattern aggregation — turns the impact_metrics table into
 * per-event-type statistics that drive (a) the /patterns UI and (b)
 * dynamic conviction-tradability scores.
 *
 * Methodology:
 *   For each (event_type, sentiment) bucket:
 *     - n     = sample count (event × asset pairs with non-null impact)
 *     - avg   = mean of impact_pct_Nd
 *     - median, stddev (computed in JS — SQLite has neither)
 *     - hit_rate = % of samples where the realised move matched the
 *                  direction implied by sentiment
 *                  (positive sentiment → expect price up = hit if pct>0,
 *                   negative sentiment → expect price down = hit if pct<0)
 */

import { db } from "@/lib/db";

export type Horizon = "1d" | "3d" | "7d";

export interface PatternStats {
  event_type: string;
  sentiment: "positive" | "negative" | "neutral";
  horizon: Horizon;
  n: number;
  avg_pct: number;
  median_pct: number;
  stddev_pct: number;
  /** Fraction of samples where direction matched expectation (0..1). */
  hit_rate: number;
  /** Empirical "tradability": how reliably this category produces a move
   *  in the expected direction. Used to override hardcoded scores. */
  empirical_tradability: number;
}

export interface PatternsByType {
  /** event_type, e.g. "exploit". */
  event_type: string;
  /** Best of (positive, negative, neutral) by sample count. */
  best: PatternStats;
  /** All breakdowns. */
  all: PatternStats[];
}

/**
 * Compute pattern stats for one horizon. Returns one row per
 * (event_type, sentiment) combo with at least 1 sample.
 */
export function computePatterns(horizon: Horizon = "1d"): PatternStats[] {
  const col = `impact_pct_${horizon}`;
  interface Row {
    event_type: string;
    sentiment: "positive" | "negative" | "neutral";
    impact: number;
  }
  const rows = db()
    .prepare<[], Row>(
      `SELECT c.event_type AS event_type,
              c.sentiment  AS sentiment,
              im.${col}    AS impact
       FROM impact_metrics im
       JOIN classifications c ON c.event_id = im.event_id
       WHERE im.${col} IS NOT NULL`,
    )
    .all();

  // Group
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.event_type}|${r.sentiment}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const out: PatternStats[] = [];
  for (const [key, samples] of groups) {
    const [event_type, sentiment] = key.split("|") as [
      string,
      PatternStats["sentiment"],
    ];
    const impacts = samples.map((s) => s.impact);
    const n = impacts.length;
    const avg = mean(impacts);
    const median = medianOf(impacts);
    const stddev = stddevOf(impacts, avg);

    // Hit rate: did the actual move match the expected direction?
    // positive sentiment → expect up → hit when impact > 0
    // negative sentiment → expect down → hit when impact < 0
    // neutral → hit if magnitude < 0.5% (i.e. didn't move much)
    let hits = 0;
    for (const im of impacts) {
      if (sentiment === "positive" && im > 0) hits++;
      else if (sentiment === "negative" && im < 0) hits++;
      else if (sentiment === "neutral" && Math.abs(im) < 0.5) hits++;
    }
    const hit_rate = n === 0 ? 0 : hits / n;

    // Empirical tradability: reliability + magnitude.
    // Reward consistent direction with non-trivial magnitude.
    // hit_rate is the directional reliability; |avg| / 5 caps at 1 around 5%.
    const magnitudeFactor = Math.min(1, Math.abs(avg) / 5);
    const empirical_tradability = hit_rate * magnitudeFactor;

    out.push({
      event_type,
      sentiment,
      horizon,
      n,
      avg_pct: avg,
      median_pct: median,
      stddev_pct: stddev,
      hit_rate,
      empirical_tradability,
    });
  }

  return out.sort((a, b) => b.n - a.n);
}

/** All horizons, grouped by event_type. */
export function computePatternsByEventType(): PatternsByType[] {
  const horizons: Horizon[] = ["1d", "3d", "7d"];
  const all = horizons.flatMap((h) => computePatterns(h));

  const byType = new Map<string, PatternStats[]>();
  for (const p of all) {
    const arr = byType.get(p.event_type) ?? [];
    arr.push(p);
    byType.set(p.event_type, arr);
  }

  const out: PatternsByType[] = [];
  for (const [event_type, list] of byType) {
    // Pick the row with the largest sample size as "best" representative.
    const best = [...list].sort((a, b) => b.n - a.n)[0];
    out.push({ event_type, best, all: list });
  }

  // Order by best sample size descending
  return out.sort((a, b) => b.best.n - a.best.n);
}

/**
 * Map of event_type → empirical tradability score for the 1d horizon.
 * Used by the signal generator to override hardcoded TRADABILITY_BY_TYPE
 * once we have enough samples (default ≥5).
 *
 * For each event_type we pick the dominant sentiment by sample count;
 * the tradability of that bucket becomes the score. event_types with
 * fewer than `minSamples` total samples return null, signaling
 * "use the hardcoded score".
 */
/**
 * Map of (event_type, sentiment) → empirical tradability score for the
 * 1d horizon. The sentiment dimension matters because earnings/positive
 * (beat) and earnings/negative (miss) are different beasts; using the
 * dominant-by-count bucket for both was washing out negative-print
 * signals.
 *
 * Returns NULL when we have insufficient samples for that exact bucket
 * (`minSamples` total — defaults to 8 here, up from 5 in v1, because
 * small samples on noisy backfilled data were destroying real signals).
 *
 * The signal generator wraps this in a bounded resolver so empirical
 * scores can adjust hardcoded baselines but can't crater them.
 */
export function empiricalTradability(
  minSamples = 8,
): Map<string, number | null> {
  const stats = computePatternsByEventType();
  const out = new Map<string, number | null>();
  for (const t of stats) {
    const oneDay = t.all.filter((s) => s.horizon === "1d");
    for (const bucket of oneDay) {
      const key = `${t.event_type}|${bucket.sentiment}`;
      if (bucket.n < minSamples) {
        out.set(key, null);
      } else {
        out.set(key, bucket.empirical_tradability);
      }
    }
  }
  return out;
}

// ─── small math helpers ────────────────────────────────────────────────

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function medianOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function stddevOf(xs: number[], mu: number): number {
  if (xs.length === 0) return 0;
  const variance = xs.reduce((s, x) => s + (x - mu) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}
