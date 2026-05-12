/**
 * Calibration dashboard SQL aggregates — Part 2.
 *
 * Five pure SQL queries against `signal_outcomes`. No LLM calls; designed
 * to render in <500ms even at 10k+ rows (each query touches one of the
 * indexes added in the schema).
 *
 * Companion tests: tests/calibration-queries.test.ts.
 */

import { db } from "@/lib/db";

interface WindowOpts {
  window_days: number;
  now_ms?: number;
  /** Filter outcomes to a single framework_version. Omit for "All". */
  frameworkVersion?: "v1" | "v2" | string;
}

function sinceMs(o: WindowOpts): number {
  const now = o.now_ms ?? Date.now();
  return now - o.window_days * 24 * 3600 * 1000;
}

/**
 * Build a SQL fragment + parameter for the framework filter. When the
 * caller doesn't specify a framework, returns an empty fragment so the
 * existing aggregate path is unchanged.
 */
function fwFilter(o: WindowOpts): { sql: string; param: string | null } {
  if (!o.frameworkVersion) return { sql: "", param: null };
  return { sql: " AND framework_version = ? ", param: o.frameworkVersion };
}

// ─────────────────────────────────────────────────────────────────────────
// Panel 1 — hit rate by tier
// ─────────────────────────────────────────────────────────────────────────

export interface HitRateByTierRow {
  tier: "auto" | "review" | "info";
  sample: number;
  target_hit: number;
  stop_hit: number;
  flat: number;
  dismissed: number;
  /** sample size of resolved-with-PnL outcomes (target/stop/flat). */
  resolved_sample: number;
  /** target_hit / resolved_sample (excludes dismissed/blocked/null). */
  hit_rate: number | null;
  mean_realized_pct: number | null;
}

export function hitRateByTier(o: WindowOpts): HitRateByTierRow[] {
  const since = sinceMs(o);
  const fw = fwFilter(o);
  const sql = `SELECT
         tier,
         SUM(CASE WHEN outcome IN ('target_hit','stop_hit','flat') THEN 1 ELSE 0 END) AS sample,
         SUM(CASE WHEN outcome = 'target_hit' THEN 1 ELSE 0 END) AS target_hit,
         SUM(CASE WHEN outcome = 'stop_hit'   THEN 1 ELSE 0 END) AS stop_hit,
         SUM(CASE WHEN outcome = 'flat'       THEN 1 ELSE 0 END) AS flat,
         SUM(CASE WHEN outcome = 'dismissed'  THEN 1 ELSE 0 END) AS dismissed,
         AVG(CASE WHEN outcome IN ('target_hit','stop_hit','flat')
                  THEN realized_pct END) AS mean_realized
       FROM signal_outcomes
       WHERE outcome IS NOT NULL
         AND outcome != 'blocked'
         AND generated_at >= ?${fw.sql}
       GROUP BY tier
       ORDER BY CASE tier WHEN 'auto' THEN 0 WHEN 'review' THEN 1 ELSE 2 END`;
  const params: Array<number | string> = [since];
  if (fw.param) params.push(fw.param);
  const rows = db().prepare(sql).all(...params) as Array<{
    tier: "auto" | "review" | "info";
    sample: number;
    target_hit: number;
    stop_hit: number;
    flat: number;
    dismissed: number;
    mean_realized: number | null;
  }>;

  return rows.map((r) => {
    const resolved = r.target_hit + r.stop_hit + r.flat;
    return {
      tier: r.tier,
      sample: r.sample,
      target_hit: r.target_hit,
      stop_hit: r.stop_hit,
      flat: r.flat,
      dismissed: r.dismissed,
      resolved_sample: resolved,
      hit_rate: resolved > 0 ? r.target_hit / resolved : null,
      mean_realized_pct: r.mean_realized,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Panel 2 — hit rate by catalyst subtype (n >= 5 only)
// ─────────────────────────────────────────────────────────────────────────

export interface HitRateBySubtypeRow {
  catalyst_subtype: string;
  sample: number;
  target_hit: number;
  stop_hit: number;
  flat: number;
  hit_rate: number | null;
  mean_realized_pct: number | null;
  median_realized_pct: number | null;
  total_pnl_usd: number;
}

export function hitRateByCatalystSubtype(
  o: WindowOpts,
): HitRateBySubtypeRow[] {
  const since = sinceMs(o);
  const fw = fwFilter(o);
  const sql = `SELECT
         catalyst_subtype,
         COUNT(*) AS sample,
         SUM(CASE WHEN outcome = 'target_hit' THEN 1 ELSE 0 END) AS target_hit,
         SUM(CASE WHEN outcome = 'stop_hit'   THEN 1 ELSE 0 END) AS stop_hit,
         SUM(CASE WHEN outcome = 'flat'       THEN 1 ELSE 0 END) AS flat,
         AVG(realized_pct) AS mean_realized,
         SUM(realized_pnl_usd) AS total_pnl
       FROM signal_outcomes
       WHERE outcome IN ('target_hit','stop_hit','flat')
         AND generated_at >= ?${fw.sql}
       GROUP BY catalyst_subtype
       HAVING sample >= 5
       ORDER BY sample DESC`;
  const params: Array<number | string> = [since];
  if (fw.param) params.push(fw.param);
  const aggregateRows = db().prepare(sql).all(...params) as Array<{
    catalyst_subtype: string;
    sample: number;
    target_hit: number;
    stop_hit: number;
    flat: number;
    mean_realized: number | null;
    total_pnl: number | null;
  }>;

  // SQLite doesn't have a built-in MEDIAN aggregate; pull the realized_pct
  // distribution per subtype and compute it in JS. Cheap enough at the
  // scales we're targeting (resolved sample per subtype is in the hundreds).
  const out: HitRateBySubtypeRow[] = [];
  for (const r of aggregateRows) {
    const medianSql = `SELECT realized_pct FROM signal_outcomes
         WHERE catalyst_subtype = ?
           AND outcome IN ('target_hit','stop_hit','flat')
           AND generated_at >= ?${fw.sql}
         ORDER BY realized_pct ASC`;
    const medianParams: Array<number | string> = [r.catalyst_subtype, since];
    if (fw.param) medianParams.push(fw.param);
    const realizedRows = db()
      .prepare(medianSql)
      .all(...medianParams) as Array<{ realized_pct: number }>;
    const median = computeMedian(realizedRows.map((x) => x.realized_pct));

    const resolved = r.target_hit + r.stop_hit + r.flat;
    out.push({
      catalyst_subtype: r.catalyst_subtype,
      sample: r.sample,
      target_hit: r.target_hit,
      stop_hit: r.stop_hit,
      flat: r.flat,
      hit_rate: resolved > 0 ? r.target_hit / resolved : null,
      mean_realized_pct: r.mean_realized,
      median_realized_pct: median,
      total_pnl_usd: r.total_pnl ?? 0,
    });
  }
  return out;
}

function computeMedian(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

// ─────────────────────────────────────────────────────────────────────────
// Panel 3 — conviction calibration curve
// ─────────────────────────────────────────────────────────────────────────

export interface CalibrationBin {
  /** Bin lower bound, percent (0,10,20,...,90). */
  bin_start: number;
  bin_end: number;
  sample: number;
  /** Mean stated conviction within the bin. */
  mean_conviction: number;
  /** Realized hit rate (target_hit / resolved_sample) within the bin. */
  hit_rate: number | null;
}

export function convictionCalibrationCurve(o: WindowOpts): CalibrationBin[] {
  const since = sinceMs(o);
  const fw = fwFilter(o);
  const sql = `SELECT
         CAST(MIN(99, FLOOR(conviction * 100 / 10) * 10) AS INTEGER) AS bin_start,
         COUNT(*) AS sample,
         AVG(conviction) AS mean_conviction,
         SUM(CASE WHEN outcome = 'target_hit' THEN 1 ELSE 0 END) AS target_hit,
         SUM(CASE WHEN outcome IN ('target_hit','stop_hit','flat') THEN 1 ELSE 0 END) AS resolved
       FROM signal_outcomes
       WHERE outcome IN ('target_hit','stop_hit','flat')
         AND generated_at >= ?${fw.sql}
       GROUP BY bin_start
       ORDER BY bin_start ASC`;
  const params: Array<number | string> = [since];
  if (fw.param) params.push(fw.param);
  const rows = db().prepare(sql).all(...params) as Array<{
    bin_start: number;
    sample: number;
    mean_conviction: number;
    target_hit: number;
    resolved: number;
  }>;

  return rows.map((r) => ({
    bin_start: r.bin_start,
    bin_end: r.bin_start + 10,
    sample: r.sample,
    mean_conviction: r.mean_conviction,
    hit_rate: r.resolved > 0 ? r.target_hit / r.resolved : null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Panel 4 — PnL by (catalyst_subtype, asset_class)
// ─────────────────────────────────────────────────────────────────────────

export interface PnlCellRow {
  catalyst_subtype: string;
  asset_class: string;
  sample: number;
  mean_realized_pct: number | null;
  total_pnl_usd: number;
}

export function pnlBySubtypeAndAssetClass(o: WindowOpts): PnlCellRow[] {
  const since = sinceMs(o);
  const fw = fwFilter(o);
  const sql = `SELECT
         catalyst_subtype,
         asset_class,
         COUNT(*) AS sample,
         AVG(realized_pct) AS mean_realized,
         SUM(realized_pnl_usd) AS total_pnl
       FROM signal_outcomes
       WHERE outcome IN ('target_hit','stop_hit','flat')
         AND generated_at >= ?${fw.sql}
       GROUP BY catalyst_subtype, asset_class
       HAVING sample >= 3
       ORDER BY sample DESC`;
  const params: Array<number | string> = [since];
  if (fw.param) params.push(fw.param);
  return (
    db().prepare(sql).all(...params) as Array<{
      catalyst_subtype: string;
      asset_class: string;
      sample: number;
      mean_realized: number | null;
      total_pnl: number | null;
    }>
  ).map((r) => ({
      catalyst_subtype: r.catalyst_subtype,
      asset_class: r.asset_class,
      sample: r.sample,
      mean_realized_pct: r.mean_realized,
      total_pnl_usd: r.total_pnl ?? 0,
    }));
}


// ─────────────────────────────────────────────────────────────────────────
// Panel 5 — top winners + losers
// ─────────────────────────────────────────────────────────────────────────

export interface ExtremeOutcomeRow {
  signal_id: string;
  asset_id: string;
  direction: "long" | "short";
  tier: "auto" | "review" | "info";
  catalyst_subtype: string;
  asset_class: string;
  conviction: number;
  realized_pct: number | null;
  realized_pnl_usd: number | null;
  outcome: string;
  generated_at: number;
}

export function topWinnersAndLosers(
  o: WindowOpts & { limit?: number },
): { winners: ExtremeOutcomeRow[]; losers: ExtremeOutcomeRow[] } {
  const since = sinceMs(o);
  const limit = o.limit ?? 10;
  const fw = fwFilter(o);
  const winnerSql = `SELECT signal_id, asset_id, direction, tier, catalyst_subtype, asset_class,
              conviction, realized_pct, realized_pnl_usd, outcome, generated_at
       FROM signal_outcomes
       WHERE outcome IN ('target_hit','flat')
         AND realized_pct IS NOT NULL
         AND generated_at >= ?${fw.sql}
       ORDER BY realized_pct DESC
       LIMIT ?`;
  const loserSql = `SELECT signal_id, asset_id, direction, tier, catalyst_subtype, asset_class,
              conviction, realized_pct, realized_pnl_usd, outcome, generated_at
       FROM signal_outcomes
       WHERE outcome IN ('stop_hit','flat')
         AND realized_pct IS NOT NULL
         AND generated_at >= ?${fw.sql}
       ORDER BY realized_pct ASC
       LIMIT ?`;
  const winnerParams: Array<number | string> = [since];
  const loserParams: Array<number | string> = [since];
  if (fw.param) {
    winnerParams.push(fw.param);
    loserParams.push(fw.param);
  }
  winnerParams.push(limit);
  loserParams.push(limit);
  const winners = db().prepare(winnerSql).all(...winnerParams) as ExtremeOutcomeRow[];
  const losers = db().prepare(loserSql).all(...loserParams) as ExtremeOutcomeRow[];
  return { winners, losers };
}

// ─────────────────────────────────────────────────────────────────────────
// Part 1 of v2.1 attribution — comparison queries (framework × ...)
// ─────────────────────────────────────────────────────────────────────────

export interface FrameworkTierRow {
  framework_version: string;
  tier: "auto" | "review" | "info";
  sample: number;
  target_hit: number;
  stop_hit: number;
  flat: number;
  hit_rate: number | null;
  mean_realized_pct: number | null;
}

export function getHitRateByFrameworkAndTier(
  o: WindowOpts,
): FrameworkTierRow[] {
  const since = sinceMs(o);
  const rows = db()
    .prepare(
      `SELECT framework_version, tier,
              SUM(CASE WHEN outcome IN ('target_hit','stop_hit','flat') THEN 1 ELSE 0 END) AS sample,
              SUM(CASE WHEN outcome = 'target_hit' THEN 1 ELSE 0 END) AS target_hit,
              SUM(CASE WHEN outcome = 'stop_hit'   THEN 1 ELSE 0 END) AS stop_hit,
              SUM(CASE WHEN outcome = 'flat'       THEN 1 ELSE 0 END) AS flat,
              AVG(CASE WHEN outcome IN ('target_hit','stop_hit','flat') THEN realized_pct END) AS mean_realized
       FROM signal_outcomes
       WHERE outcome IN ('target_hit','stop_hit','flat')
         AND generated_at >= ?
       GROUP BY framework_version, tier
       ORDER BY framework_version, tier`,
    )
    .all(since) as Array<{
    framework_version: string;
    tier: "auto" | "review" | "info";
    sample: number;
    target_hit: number;
    stop_hit: number;
    flat: number;
    mean_realized: number | null;
  }>;
  return rows.map((r) => ({
    framework_version: r.framework_version,
    tier: r.tier,
    sample: r.sample,
    target_hit: r.target_hit,
    stop_hit: r.stop_hit,
    flat: r.flat,
    hit_rate: r.sample > 0 ? r.target_hit / r.sample : null,
    mean_realized_pct: r.mean_realized,
  }));
}

export interface FrameworkSubtypePnlRow {
  framework_version: string;
  catalyst_subtype: string;
  sample: number;
  mean_realized_pct: number | null;
  total_pnl_usd: number;
}

export function getPnlByFrameworkAndCatalystSubtype(
  o: WindowOpts,
): FrameworkSubtypePnlRow[] {
  const since = sinceMs(o);
  return (
    db()
      .prepare(
        `SELECT framework_version, catalyst_subtype,
                COUNT(*) AS sample,
                AVG(realized_pct) AS mean_realized,
                SUM(realized_pnl_usd) AS total_pnl
         FROM signal_outcomes
         WHERE outcome IN ('target_hit','stop_hit','flat')
           AND generated_at >= ?
         GROUP BY framework_version, catalyst_subtype
         ORDER BY framework_version, sample DESC`,
      )
      .all(since) as Array<{
      framework_version: string;
      catalyst_subtype: string;
      sample: number;
      mean_realized: number | null;
      total_pnl: number | null;
    }>
  ).map((r) => ({
    framework_version: r.framework_version,
    catalyst_subtype: r.catalyst_subtype,
    sample: r.sample,
    mean_realized_pct: r.mean_realized,
    total_pnl_usd: r.total_pnl ?? 0,
  }));
}

export function getCalibrationCurveByFramework(
  o: WindowOpts,
): CalibrationBin[] {
  // Same logic as convictionCalibrationCurve but always with a
  // framework filter. Caller usually passes one fw at a time and
  // renders the two curves overlayed.
  return convictionCalibrationCurve(o);
}

export interface FrameworkSummaryEntry {
  sample: number;
  target_hit: number;
  stop_hit: number;
  flat: number;
  hit_rate: number | null;
  total_pnl_usd: number;
  mean_realized_pct: number | null;
}

export interface FrameworkSummary {
  v1: FrameworkSummaryEntry;
  v2: FrameworkSummaryEntry;
  /** v2 minus v1 — positive numbers favor v2.1. */
  delta: {
    hit_rate: number;
    total_pnl_usd: number;
    mean_realized_pct: number;
    sample: number;
  };
}

export function getFrameworkSummary(o: WindowOpts): FrameworkSummary {
  const since = sinceMs(o);
  const rows = db()
    .prepare(
      `SELECT framework_version,
              SUM(CASE WHEN outcome IN ('target_hit','stop_hit','flat') THEN 1 ELSE 0 END) AS sample,
              SUM(CASE WHEN outcome = 'target_hit' THEN 1 ELSE 0 END) AS target_hit,
              SUM(CASE WHEN outcome = 'stop_hit'   THEN 1 ELSE 0 END) AS stop_hit,
              SUM(CASE WHEN outcome = 'flat'       THEN 1 ELSE 0 END) AS flat,
              SUM(realized_pnl_usd) AS total_pnl,
              AVG(realized_pct) AS mean_realized
       FROM signal_outcomes
       WHERE outcome IN ('target_hit','stop_hit','flat')
         AND generated_at >= ?
       GROUP BY framework_version`,
    )
    .all(since) as Array<{
    framework_version: string;
    sample: number;
    target_hit: number;
    stop_hit: number;
    flat: number;
    total_pnl: number | null;
    mean_realized: number | null;
  }>;
  const empty: FrameworkSummaryEntry = {
    sample: 0,
    target_hit: 0,
    stop_hit: 0,
    flat: 0,
    hit_rate: null,
    total_pnl_usd: 0,
    mean_realized_pct: null,
  };
  const byFw = new Map<string, FrameworkSummaryEntry>();
  for (const r of rows) {
    byFw.set(r.framework_version, {
      sample: r.sample,
      target_hit: r.target_hit,
      stop_hit: r.stop_hit,
      flat: r.flat,
      hit_rate: r.sample > 0 ? r.target_hit / r.sample : null,
      total_pnl_usd: r.total_pnl ?? 0,
      mean_realized_pct: r.mean_realized,
    });
  }
  const v1 = byFw.get("v1") ?? empty;
  const v2 = byFw.get("v2") ?? empty;
  return {
    v1,
    v2,
    delta: {
      hit_rate: (v2.hit_rate ?? 0) - (v1.hit_rate ?? 0),
      total_pnl_usd: v2.total_pnl_usd - v1.total_pnl_usd,
      mean_realized_pct: (v2.mean_realized_pct ?? 0) - (v1.mean_realized_pct ?? 0),
      sample: v2.sample - v1.sample,
    },
  };
}
