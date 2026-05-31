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
