/**
 * Repository — AlphaIndex persistence. Wave 2: async.
 */

import { all, get, run } from "../client";

export interface IndexRow {
  id: string;
  name: string;
  description: string | null;
  starting_nav: number;
  created_at: number;
  updated_at: number;
}

export interface IndexPositionRow {
  index_id: string;
  asset_id: string;
  target_weight: number;
  current_value_usd: number;
  avg_entry_price: number | null;
  quantity: number;
  rationale: string | null;
  last_updated: number;
}

export interface IndexRebalanceRow {
  id: string;
  index_id: string;
  rebalanced_at: number;
  triggered_by: "scheduled" | "manual" | "signal_cluster" | string;
  pre_nav: number;
  post_nav: number;
  old_weights: Record<string, number>;
  new_weights: Record<string, number>;
  trades_made: Array<{
    asset_id: string;
    side: "buy" | "sell";
    size_usd: number;
    fill_price: number;
  }>;
  reasoning: string;
  reviewer_model: string | null;
  framework_version?: "v1" | "v2";
}

export interface IndexNavRow {
  index_id: string;
  date: string;
  nav_usd: number;
  pnl_usd: number;
  pnl_pct: number;
  btc_price: number | null;
  ssimag7_price: number | null;
}

export async function getIndex(id: string): Promise<IndexRow | undefined> {
  return get<IndexRow>(`SELECT * FROM indexes WHERE id = ?`, [id]);
}

export async function listIndexes(): Promise<IndexRow[]> {
  return all<IndexRow>(`SELECT * FROM indexes ORDER BY created_at`);
}

export async function listPositions(
  indexId: string,
): Promise<IndexPositionRow[]> {
  return all<IndexPositionRow>(
    `SELECT * FROM index_positions WHERE index_id = ?
     ORDER BY current_value_usd DESC`,
    [indexId],
  );
}

export async function upsertPosition(p: {
  index_id: string;
  asset_id: string;
  target_weight: number;
  current_value_usd?: number;
  avg_entry_price?: number | null;
  quantity?: number;
  rationale?: string | null;
}): Promise<void> {
  const preserveRationale = p.rationale === undefined;
  await run(
    `INSERT INTO index_positions
       (index_id, asset_id, target_weight, current_value_usd,
        avg_entry_price, quantity, rationale, last_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch() * 1000)
     ON CONFLICT(index_id, asset_id) DO UPDATE SET
       target_weight     = excluded.target_weight,
       current_value_usd = excluded.current_value_usd,
       avg_entry_price   = excluded.avg_entry_price,
       quantity          = excluded.quantity,
       rationale         = CASE WHEN ? = 1
                                THEN index_positions.rationale
                                ELSE excluded.rationale END,
       last_updated      = excluded.last_updated`,
    [
      p.index_id,
      p.asset_id,
      p.target_weight,
      p.current_value_usd ?? 0,
      p.avg_entry_price ?? null,
      p.quantity ?? 0,
      p.rationale ?? null,
      preserveRationale ? 1 : 0,
    ],
  );
}

export async function clearZeroPositions(
  indexId: string,
  threshold = 0.0001,
): Promise<number> {
  const r = await run(
    `DELETE FROM index_positions WHERE index_id = ? AND target_weight < ?`,
    [indexId, threshold],
  );
  return Number(r.rowsAffected);
}

export async function insertRebalance(
  r: Omit<IndexRebalanceRow, "rebalanced_at"> & { rebalanced_at?: number },
): Promise<void> {
  await run(
    `INSERT INTO index_rebalances
       (id, index_id, rebalanced_at, triggered_by, pre_nav, post_nav,
        old_weights, new_weights, trades_made, reasoning, reviewer_model,
        framework_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.id,
      r.index_id,
      r.rebalanced_at ?? Date.now(),
      r.triggered_by,
      r.pre_nav,
      r.post_nav,
      JSON.stringify(r.old_weights),
      JSON.stringify(r.new_weights),
      JSON.stringify(r.trades_made),
      r.reasoning,
      r.reviewer_model,
      r.framework_version ?? "v1",
    ],
  );
}

export async function listRebalances(
  indexId: string,
  limit = 50,
): Promise<IndexRebalanceRow[]> {
  interface Raw {
    id: string;
    index_id: string;
    rebalanced_at: number;
    triggered_by: string;
    pre_nav: number;
    post_nav: number;
    old_weights: string;
    new_weights: string;
    trades_made: string;
    reasoning: string;
    reviewer_model: string | null;
  }
  const rows = await all<Raw>(
    `SELECT * FROM index_rebalances
     WHERE index_id = ?
     ORDER BY rebalanced_at DESC
     LIMIT ?`,
    [indexId, limit],
  );
  return rows.map((r) => ({
    ...r,
    old_weights: JSON.parse(r.old_weights),
    new_weights: JSON.parse(r.new_weights),
    trades_made: JSON.parse(r.trades_made),
  }));
}

export async function snapshotNav(row: IndexNavRow): Promise<void> {
  await run(
    `INSERT INTO index_nav_history (index_id, date, nav_usd, pnl_usd, pnl_pct, btc_price, ssimag7_price)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(index_id, date) DO UPDATE SET
       nav_usd       = excluded.nav_usd,
       pnl_usd       = excluded.pnl_usd,
       pnl_pct       = excluded.pnl_pct,
       btc_price     = excluded.btc_price,
       ssimag7_price = excluded.ssimag7_price`,
    [
      row.index_id,
      row.date,
      row.nav_usd,
      row.pnl_usd,
      row.pnl_pct,
      row.btc_price ?? null,
      row.ssimag7_price ?? null,
    ],
  );
}

export async function listNavHistory(
  indexId: string,
  days = 90,
): Promise<IndexNavRow[]> {
  const rows = await all<IndexNavRow>(
    `SELECT * FROM index_nav_history
     WHERE index_id = ?
     ORDER BY date DESC
     LIMIT ?`,
    [indexId, days],
  );
  return rows.reverse();
}

export interface SignalAttributionRow {
  id: string;
  index_id: string;
  rebalance_id: string;
  asof_ms: number;
  pre_nav_usd: number;
  weight_deltas_bps: Record<string, number>;
  realized_pnl_usd: Record<string, number> | null;
  total_pnl_usd: number | null;
  sanity_ok: boolean;
  sanity_note: string | null;
  created_at: number;
  resolved_at: number | null;
}

export async function insertSignalAttribution(r: {
  id: string;
  index_id: string;
  rebalance_id: string;
  asof_ms: number;
  pre_nav_usd: number;
  weight_deltas_bps: Record<string, number>;
  sanity_ok: boolean;
  sanity_note?: string | null;
}): Promise<void> {
  await run(
    `INSERT INTO signal_pnl_attribution
       (id, index_id, rebalance_id, asof_ms, pre_nav_usd,
        weight_deltas_bps, realized_pnl_usd, total_pnl_usd,
        sanity_ok, sanity_note)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    [
      r.id,
      r.index_id,
      r.rebalance_id,
      r.asof_ms,
      r.pre_nav_usd,
      JSON.stringify(r.weight_deltas_bps),
      r.sanity_ok ? 1 : 0,
      r.sanity_note ?? null,
    ],
  );
}

export async function resolveSignalAttribution(
  id: string,
  realized_pnl_usd: Record<string, number>,
  total_pnl_usd: number,
  resolved_at_ms: number,
): Promise<void> {
  await run(
    `UPDATE signal_pnl_attribution
     SET realized_pnl_usd = ?,
         total_pnl_usd    = ?,
         resolved_at      = ?
     WHERE id = ?`,
    [JSON.stringify(realized_pnl_usd), total_pnl_usd, resolved_at_ms, id],
  );
}

export async function listSignalAttributions(
  indexId: string,
  limit = 30,
): Promise<SignalAttributionRow[]> {
  interface Raw {
    id: string;
    index_id: string;
    rebalance_id: string;
    asof_ms: number;
    pre_nav_usd: number;
    weight_deltas_bps: string;
    realized_pnl_usd: string | null;
    total_pnl_usd: number | null;
    sanity_ok: number;
    sanity_note: string | null;
    created_at: number;
    resolved_at: number | null;
  }
  const rows = await all<Raw>(
    `SELECT * FROM signal_pnl_attribution
     WHERE index_id = ?
     ORDER BY asof_ms DESC
     LIMIT ?`,
    [indexId, limit],
  );
  return rows.map((r) => ({
    ...r,
    weight_deltas_bps: safeJson(r.weight_deltas_bps, {}),
    realized_pnl_usd: r.realized_pnl_usd ? safeJson(r.realized_pnl_usd, {}) : null,
    sanity_ok: r.sanity_ok === 1,
  }));
}

export async function listUnresolvedAttributions(
  indexId: string,
): Promise<SignalAttributionRow[]> {
  interface Raw {
    id: string;
    index_id: string;
    rebalance_id: string;
    asof_ms: number;
    pre_nav_usd: number;
    weight_deltas_bps: string;
    realized_pnl_usd: string | null;
    total_pnl_usd: number | null;
    sanity_ok: number;
    sanity_note: string | null;
    created_at: number;
    resolved_at: number | null;
  }
  const rows = await all<Raw>(
    `SELECT * FROM signal_pnl_attribution
     WHERE index_id = ? AND resolved_at IS NULL AND sanity_ok = 1
     ORDER BY asof_ms ASC`,
    [indexId],
  );
  return rows.map((r) => ({
    ...r,
    weight_deltas_bps: safeJson(r.weight_deltas_bps, {}),
    realized_pnl_usd: r.realized_pnl_usd ? safeJson(r.realized_pnl_usd, {}) : null,
    sanity_ok: r.sanity_ok === 1,
  }));
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
