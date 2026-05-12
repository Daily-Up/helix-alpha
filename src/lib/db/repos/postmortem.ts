/**
 * Postmortem queries — close the loop between signal predictions and
 * actual price outcomes.
 *
 * The pipeline is:
 *   classifications → signals (we predict X will move price by Y%)
 *   news_events → impact_metrics (price actually moved by Z%)
 *
 * This file joins those tables to answer "how did our signals actually
 * perform?" The answers feed the /learnings page so the user can see
 * calibration drift, which event types are profitable to trade, and
 * which signal tiers are pulling weight.
 *
 * A signal is counted as a "hit" at horizon H if:
 *   direction = long  AND impact_pct_H > 0
 *   direction = short AND impact_pct_H < 0
 *
 * "Realised PnL" for a signal is the directional impact:
 *   long  → +impact_pct_H
 *   short → -impact_pct_H
 *
 * We do NOT account for stop-loss / take-profit yet — that's a paper-
 * trades exercise. This is signal-level calibration, not trade-level
 * P&L.
 */

import { db } from "../client";

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export type Horizon = "1d" | "3d" | "7d";

/** Common bucket result shape so the API + UI can render any breakdown
 *  uniformly. The `key` field carries whatever we grouped by (event_type,
 *  tier, confidence bucket label, asset kind, etc.). */
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
  /** Signals with at least one impact metric measured (i.e. evaluable). */
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
  /** Directional PnL = +impact for long, -impact for short. NULL if
   *  the corresponding impact is missing. */
  pnl_pct_1d: number | null;
  pnl_pct_3d: number | null;
  pnl_pct_7d: number | null;
}

// ─────────────────────────────────────────────────────────────────────────
// SQL fragments — kept as constants so every query uses the same join
// shape and PnL definition.
// ─────────────────────────────────────────────────────────────────────────

/** Directional PnL: positive when the move agreed with the signal direction. */
const PNL_1D = `(CASE WHEN s.direction = 'long' THEN i.impact_pct_1d ELSE -i.impact_pct_1d END)`;
const PNL_3D = `(CASE WHEN s.direction = 'long' THEN i.impact_pct_3d ELSE -i.impact_pct_3d END)`;
const PNL_7D = `(CASE WHEN s.direction = 'long' THEN i.impact_pct_7d ELSE -i.impact_pct_7d END)`;

/** Hit indicator (1 = hit, 0 = miss, NULL when impact is null so AVG ignores it). */
const HIT_1D = `(CASE WHEN i.impact_pct_1d IS NULL THEN NULL WHEN ${PNL_1D} > 0 THEN 1.0 ELSE 0.0 END)`;
const HIT_3D = `(CASE WHEN i.impact_pct_3d IS NULL THEN NULL WHEN ${PNL_3D} > 0 THEN 1.0 ELSE 0.0 END)`;
const HIT_7D = `(CASE WHEN i.impact_pct_7d IS NULL THEN NULL WHEN ${PNL_7D} > 0 THEN 1.0 ELSE 0.0 END)`;

/** Base join: signals → impact_metrics → classifications → assets. We
 *  LEFT JOIN classifications because some legacy signals predate the
 *  classification record but still have an impact (rare). */
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

// ─────────────────────────────────────────────────────────────────────────
// Public queries
// ─────────────────────────────────────────────────────────────────────────

export interface PostmortemFilter {
  /** Only include signals fired within this many ms of "now". */
  since_ms?: number;
  /** Optional asset class filter. */
  asset_kind?: string;
}

/** Headline numbers across all evaluable signals. Two cheap queries:
 *  one counts every signal in the filter window (even unmeasured ones);
 *  the other averages hit rates + PnL over signals that joined to an
 *  impact_metrics row. */
export function overallStats(filter: PostmortemFilter = {}): OverallStats {
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
  const agg = db()
    .prepare<typeof params, AggRow>(
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
    )
    .get(...params);

  // Total signals in the same filter window, including ones that haven't
  // been measured yet (no impact_metrics row).
  const { whereSql: whereSignalsOnly, params: signalParams } =
    buildWhere(filter, { signalsOnly: true });
  const total = db()
    .prepare<typeof signalParams, { n: number }>(
      `SELECT COUNT(*) AS n FROM signals s ${whereSignalsOnly}`,
    )
    .get(...signalParams);

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

/** Calibration check: bucket signals by confidence band, see if higher
 *  confidence actually delivers higher hit rates. If 0.9+ signals only
 *  hit 50% of the time, our model is mis-calibrated. */
export function statsByConfidence(filter: PostmortemFilter = {}): BucketStats[] {
  const { whereSql, params } = buildWhere(filter);
  return db()
    .prepare<typeof params, BucketStats>(
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
    )
    .all(...params);
}

/** Performance by event type: regulatory news vs. exploits vs. earnings,
 *  etc. Drives the "which catalysts are worth trading" insight. */
export function statsByEventType(filter: PostmortemFilter = {}): BucketStats[] {
  const { whereSql, params } = buildWhere(filter);
  return db()
    .prepare<typeof params, BucketStats>(
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
    )
    .all(...params);
}

/** Performance by tier (auto / review / info). If "info" tier has worse
 *  hit rate than coin-flip, info-tier signals aren't worth showing. */
export function statsByTier(filter: PostmortemFilter = {}): BucketStats[] {
  const { whereSql, params } = buildWhere(filter);
  return db()
    .prepare<typeof params, BucketStats>(
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
    )
    .all(...params);
}

/** Performance by asset kind (token / stock / etf / rwa). Tells us
 *  whether the system is better at predicting crypto majors vs. crypto-
 *  stocks vs. ETFs. */
export function statsByAssetKind(filter: PostmortemFilter = {}): BucketStats[] {
  const { whereSql, params } = buildWhere(filter);
  return db()
    .prepare<typeof params, BucketStats>(
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
    )
    .all(...params);
}

/** Recent signals with their measured outcomes — the table that lets
 *  the user spot-check "this specific 0.85 conf BTC long actually
 *  returned -3% in 3 days". Limited; don't pull thousands. */
export function recentSignalOutcomes(
  limit = 100,
  filter: PostmortemFilter = {},
): SignalOutcomeRow[] {
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
  const rows = db()
    .prepare<[...typeof params, number], Raw>(
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
    )
    .all(...params, limit);

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

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Build WHERE clause + positional params from a filter. `signalsOnly`
 *  drops impact/classification predicates for queries that count the
 *  raw signals table without a join. */
function buildWhere(
  filter: PostmortemFilter,
  opts: { signalsOnly?: boolean } = {},
): { whereSql: string; params: number[] } {
  const clauses: string[] = [];
  const params: number[] = [];
  if (filter.since_ms != null) {
    clauses.push(`s.fired_at >= ?`);
    params.push(Date.now() - filter.since_ms);
  }
  if (filter.asset_kind && !opts.signalsOnly) {
    // Only available when we've joined `assets` (signalsOnly=false).
    clauses.push(`a.kind = ?`);
    // params is number[] — TS quirk; cast through unknown since the
    // prepared statement accepts mixed primitive bindings.
    (params as unknown as Array<string | number>).push(filter.asset_kind);
  }
  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}
