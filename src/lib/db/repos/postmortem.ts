/**
 * Postmortem queries — close the loop between signal predictions and
 * actual price outcomes. Wave 2: async.
 */

import { all, get } from "../client";

export type Horizon = "1d" | "3d" | "7d";

export interface BucketStats {
  key: string;
  count: number;
  hit_rate_1d: number | null;
  hit_rate_3d: number | null;
  hit_rate_7d: number | null;
  avg_pnl_pct_1d: number | null;
  avg_pnl_pct_3d: number | null;
  avg_pnl_pct_7d: number | null;
}

export interface OverallStats {
  total_signals: number;
  evaluable: number;
  hit_rate_1d: number | null;
  hit_rate_3d: number | null;
  hit_rate_7d: number | null;
  avg_pnl_pct_1d: number | null;
  avg_pnl_pct_3d: number | null;
  avg_pnl_pct_7d: number | null;
}

export interface SignalOutcomeRow {
  signal_id: string;
  fired_at: number;
  asset_id: string;
  asset_symbol: string;
  asset_kind: string;
  direction: "long" | "short";
  tier: "auto" | "review" | "info";
  confidence: number;
  event_type: string | null;
  event_title: string | null;
  reasoning: string;
  impact_pct_1d: number | null;
  impact_pct_3d: number | null;
  impact_pct_7d: number | null;
  pnl_pct_1d: number | null;
  pnl_pct_3d: number | null;
  pnl_pct_7d: number | null;
}

const PNL_1D = `(CASE WHEN s.direction = 'long' THEN i.impact_pct_1d ELSE -i.impact_pct_1d END)`;
const PNL_3D = `(CASE WHEN s.direction = 'long' THEN i.impact_pct_3d ELSE -i.impact_pct_3d END)`;
const PNL_7D = `(CASE WHEN s.direction = 'long' THEN i.impact_pct_7d ELSE -i.impact_pct_7d END)`;

const HIT_1D = `(CASE WHEN i.impact_pct_1d IS NULL THEN NULL WHEN ${PNL_1D} > 0 THEN 1.0 ELSE 0.0 END)`;
const HIT_3D = `(CASE WHEN i.impact_pct_3d IS NULL THEN NULL WHEN ${PNL_3D} > 0 THEN 1.0 ELSE 0.0 END)`;
const HIT_7D = `(CASE WHEN i.impact_pct_7d IS NULL THEN NULL WHEN ${PNL_7D} > 0 THEN 1.0 ELSE 0.0 END)`;

const BASE_JOIN = `
  FROM signals s
  JOIN impact_metrics i
    ON i.event_id = s.triggered_by_event_id
   AND i.asset_id = s.asset_id
  LEFT JOIN classifications c
    ON c.event_id = s.triggered_by_event_id
  LEFT JOIN assets a
    ON a.id = s.asset_id
`;

export interface PostmortemFilter {
  since_ms?: number;
  asset_kind?: string;
}

export async function overallStats(
  filter: PostmortemFilter = {},
): Promise<OverallStats> {
  const { whereSql, params } = buildWhere(filter);

  interface AggRow {
    evaluable: number;
    hit_rate_1d: number | null;
    hit_rate_3d: number | null;
    hit_rate_7d: number | null;
    avg_pnl_pct_1d: number | null;
    avg_pnl_pct_3d: number | null;
    avg_pnl_pct_7d: number | null;
  }
  const agg = await get<AggRow>(
    `SELECT
       COUNT(*)         AS evaluable,
       AVG(${HIT_1D})   AS hit_rate_1d,
       AVG(${HIT_3D})   AS hit_rate_3d,
       AVG(${HIT_7D})   AS hit_rate_7d,
       AVG(${PNL_1D})   AS avg_pnl_pct_1d,
       AVG(${PNL_3D})   AS avg_pnl_pct_3d,
       AVG(${PNL_7D})   AS avg_pnl_pct_7d
     ${BASE_JOIN}
     ${whereSql}`,
    params,
  );

  const { whereSql: whereSignalsOnly, params: signalParams } = buildWhere(
    filter,
    { signalsOnly: true },
  );
  const total = await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM signals s ${whereSignalsOnly}`,
    signalParams,
  );

  return {
    total_signals: total?.n ?? 0,
    evaluable: agg?.evaluable ?? 0,
    hit_rate_1d: agg?.hit_rate_1d ?? null,
    hit_rate_3d: agg?.hit_rate_3d ?? null,
    hit_rate_7d: agg?.hit_rate_7d ?? null,
    avg_pnl_pct_1d: agg?.avg_pnl_pct_1d ?? null,
    avg_pnl_pct_3d: agg?.avg_pnl_pct_3d ?? null,
    avg_pnl_pct_7d: agg?.avg_pnl_pct_7d ?? null,
  };
}

export async function statsByConfidence(
  filter: PostmortemFilter = {},
): Promise<BucketStats[]> {
  const { whereSql, params } = buildWhere(filter);
  return all<BucketStats>(
    `SELECT
       CASE
         WHEN s.confidence < 0.50 THEN '<0.50'
         WHEN s.confidence < 0.60 THEN '0.50-0.60'
         WHEN s.confidence < 0.70 THEN '0.60-0.70'
         WHEN s.confidence < 0.80 THEN '0.70-0.80'
         WHEN s.confidence < 0.90 THEN '0.80-0.90'
         ELSE '0.90-1.00'
       END                                AS key,
       COUNT(*)                           AS count,
       AVG(${HIT_1D})                     AS hit_rate_1d,
       AVG(${HIT_3D})                     AS hit_rate_3d,
       AVG(${HIT_7D})                     AS hit_rate_7d,
       AVG(${PNL_1D})                     AS avg_pnl_pct_1d,
       AVG(${PNL_3D})                     AS avg_pnl_pct_3d,
       AVG(${PNL_7D})                     AS avg_pnl_pct_7d
     ${BASE_JOIN}
     ${whereSql}
     GROUP BY key
     ORDER BY key`,
    params,
  );
}

export async function statsByEventType(
  filter: PostmortemFilter = {},
): Promise<BucketStats[]> {
  const { whereSql, params } = buildWhere(filter);
  return all<BucketStats>(
    `SELECT
       COALESCE(c.event_type, 'unknown') AS key,
       COUNT(*)                           AS count,
       AVG(${HIT_1D})                     AS hit_rate_1d,
       AVG(${HIT_3D})                     AS hit_rate_3d,
       AVG(${HIT_7D})                     AS hit_rate_7d,
       AVG(${PNL_1D})                     AS avg_pnl_pct_1d,
       AVG(${PNL_3D})                     AS avg_pnl_pct_3d,
       AVG(${PNL_7D})                     AS avg_pnl_pct_7d
     ${BASE_JOIN}
     ${whereSql}
     GROUP BY key
     ORDER BY count DESC`,
    params,
  );
}

export async function statsByTier(
  filter: PostmortemFilter = {},
): Promise<BucketStats[]> {
  const { whereSql, params } = buildWhere(filter);
  return all<BucketStats>(
    `SELECT
       s.tier                             AS key,
       COUNT(*)                           AS count,
       AVG(${HIT_1D})                     AS hit_rate_1d,
       AVG(${HIT_3D})                     AS hit_rate_3d,
       AVG(${HIT_7D})                     AS hit_rate_7d,
       AVG(${PNL_1D})                     AS avg_pnl_pct_1d,
       AVG(${PNL_3D})                     AS avg_pnl_pct_3d,
       AVG(${PNL_7D})                     AS avg_pnl_pct_7d
     ${BASE_JOIN}
     ${whereSql}
     GROUP BY key
     ORDER BY count DESC`,
    params,
  );
}

export async function statsByAssetKind(
  filter: PostmortemFilter = {},
): Promise<BucketStats[]> {
  const { whereSql, params } = buildWhere(filter);
  return all<BucketStats>(
    `SELECT
       COALESCE(a.kind, 'unknown')        AS key,
       COUNT(*)                           AS count,
       AVG(${HIT_1D})                     AS hit_rate_1d,
       AVG(${HIT_3D})                     AS hit_rate_3d,
       AVG(${HIT_7D})                     AS hit_rate_7d,
       AVG(${PNL_1D})                     AS avg_pnl_pct_1d,
       AVG(${PNL_3D})                     AS avg_pnl_pct_3d,
       AVG(${PNL_7D})                     AS avg_pnl_pct_7d
     ${BASE_JOIN}
     ${whereSql}
     GROUP BY key
     ORDER BY count DESC`,
    params,
  );
}

export async function recentSignalOutcomes(
  limit = 100,
  filter: PostmortemFilter = {},
): Promise<SignalOutcomeRow[]> {
  const { whereSql, params } = buildWhere(filter);
  interface Raw {
    signal_id: string;
    fired_at: number;
    asset_id: string;
    asset_symbol: string;
    asset_kind: string;
    direction: "long" | "short";
    tier: "auto" | "review" | "info";
    confidence: number;
    event_type: string | null;
    event_title: string | null;
    reasoning: string;
    impact_pct_1d: number | null;
    impact_pct_3d: number | null;
    impact_pct_7d: number | null;
  }
  const rows = await all<Raw>(
    `SELECT
       s.id                AS signal_id,
       s.fired_at          AS fired_at,
       s.asset_id          AS asset_id,
       a.symbol            AS asset_symbol,
       a.kind              AS asset_kind,
       s.direction         AS direction,
       s.tier              AS tier,
       s.confidence        AS confidence,
       c.event_type        AS event_type,
       e.title             AS event_title,
       s.reasoning         AS reasoning,
       i.impact_pct_1d     AS impact_pct_1d,
       i.impact_pct_3d     AS impact_pct_3d,
       i.impact_pct_7d     AS impact_pct_7d
     ${BASE_JOIN}
     LEFT JOIN news_events e ON e.id = s.triggered_by_event_id
     ${whereSql}
     ORDER BY s.fired_at DESC
     LIMIT ?`,
    [...params, limit],
  );

  return rows.map((r) => ({
    ...r,
    pnl_pct_1d:
      r.impact_pct_1d == null
        ? null
        : (r.direction === "long" ? 1 : -1) * r.impact_pct_1d,
    pnl_pct_3d:
      r.impact_pct_3d == null
        ? null
        : (r.direction === "long" ? 1 : -1) * r.impact_pct_3d,
    pnl_pct_7d:
      r.impact_pct_7d == null
        ? null
        : (r.direction === "long" ? 1 : -1) * r.impact_pct_7d,
  }));
}

// ── Live grading stats (signal_outcomes) ────────────────────────────────
//
// The bucket stats above read `impact_metrics`, populated by the
// compute-impact job. The *live* feedback loop the resolution job writes
// every tick is `signal_outcomes` (outcome ∈ target_hit|stop_hit|flat once
// an horizon elapses). These helpers report that live grader so the homepage
// can show a real hit rate + "N graded" instead of an indefinite
// "calibrating…", and a concrete "first grades on <date>" before any resolve.

export interface GradedOutcomeStats {
  /** Resolved outcomes (target_hit | stop_hit | flat) in the window. */
  graded: number;
  /** Of those, how many were directionally favourable (realized_pct > 0). */
  wins: number;
  /** wins / graded, or null when nothing is graded yet. */
  hit_rate: number | null;
  /** When graded === 0: the soonest a pending outcome becomes gradable
   *  (MIN expires_at over outcome IS NULL). null when nothing is pending. */
  first_grade_at: number | null;
}

export async function gradedOutcomeStats(
  sinceMs = 30 * 24 * 60 * 60 * 1000,
): Promise<GradedOutcomeStats> {
  const since = Date.now() - sinceMs;
  const agg = await get<{ graded: number; wins: number }>(
    `SELECT COUNT(*) AS graded,
            COALESCE(SUM(CASE WHEN realized_pct > 0 THEN 1 ELSE 0 END), 0) AS wins
       FROM signal_outcomes
      WHERE outcome IN ('target_hit','stop_hit','flat')
        AND generated_at >= ?`,
    [since],
  );
  const graded = agg?.graded ?? 0;
  const wins = agg?.wins ?? 0;
  let first_grade_at: number | null = null;
  if (graded === 0) {
    const soonest = await get<{ soonest: number | null }>(
      `SELECT MIN(expires_at) AS soonest
         FROM signal_outcomes
        WHERE outcome IS NULL`,
    );
    first_grade_at = soonest?.soonest ?? null;
  }
  return {
    graded,
    wins,
    hit_rate: graded > 0 ? wins / graded : null,
    first_grade_at,
  };
}

export interface RecentGradedOutcome {
  signal_id: string;
  asset_symbol: string;
  asset_kind: string;
  sodex_symbol: string | null;
  direction: "long" | "short";
  outcome: "target_hit" | "stop_hit" | "flat";
  realized_pct: number | null;
  outcome_at: number | null;
}

/** The most recently resolved signals with their graded outcome — used as the
 *  homepage "Top pending signals" fallback when nothing is live. */
export async function recentGradedOutcomes(
  limit = 3,
): Promise<RecentGradedOutcome[]> {
  return all<RecentGradedOutcome>(
    `SELECT o.signal_id          AS signal_id,
            a.symbol             AS asset_symbol,
            a.kind               AS asset_kind,
            s.sodex_symbol       AS sodex_symbol,
            o.direction          AS direction,
            o.outcome            AS outcome,
            o.realized_pct       AS realized_pct,
            o.outcome_at         AS outcome_at
       FROM signal_outcomes o
       LEFT JOIN signals s ON s.id = o.signal_id
       LEFT JOIN assets  a ON a.id = o.asset_id
      WHERE o.outcome IN ('target_hit','stop_hit','flat')
      ORDER BY o.outcome_at DESC
      LIMIT ?`,
    [limit],
  );
}

function buildWhere(
  filter: PostmortemFilter,
  opts: { signalsOnly?: boolean } = {},
): { whereSql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.since_ms != null) {
    clauses.push(`s.fired_at >= ?`);
    params.push(Date.now() - filter.since_ms);
  }
  if (filter.asset_kind && !opts.signalsOnly) {
    clauses.push(`a.kind = ?`);
    params.push(filter.asset_kind);
  }
  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}
