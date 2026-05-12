/**
 * Repository — `indexes`, `index_positions`, `index_rebalances`,
 * `index_nav_history`. The "AlphaIndex" / AlphaCore persistence layer.
 *
 * AlphaIndex is the AI-managed portfolio side of the product (the
 * "one-person BlackRock" pitch). Lives separate from `paper_trades`
 * which is for tactical AlphaTrade signals.
 */

import { db } from "../client";

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
  target_weight: number; // 0..1
  current_value_usd: number;
  avg_entry_price: number | null;
  quantity: number;
  /** Human-readable reason this asset is in the portfolio. Built from the
   *  weight engine's drivers. Null on legacy rows pre-rationale migration. */
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
  /** Parsed; in the DB this is a JSON string. */
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
  /** Allocation framework that produced this row. Default 'v1' for
   *  back-compat with rows pre-graduation. */
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

// ─────────────────────────────────────────────────────────────────────────
// Index
// ─────────────────────────────────────────────────────────────────────────

export function getIndex(id: string): IndexRow | undefined {
  return db()
    .prepare<[string], IndexRow>(`SELECT * FROM indexes WHERE id = ?`)
    .get(id);
}

export function listIndexes(): IndexRow[] {
  return db()
    .prepare<[], IndexRow>(`SELECT * FROM indexes ORDER BY created_at`)
    .all();
}

// ─────────────────────────────────────────────────────────────────────────
// Positions
// ─────────────────────────────────────────────────────────────────────────

export function listPositions(indexId: string): IndexPositionRow[] {
  return db()
    .prepare<[string], IndexPositionRow>(
      `SELECT * FROM index_positions WHERE index_id = ?
       ORDER BY current_value_usd DESC`,
    )
    .all(indexId);
}

export function upsertPosition(p: {
  index_id: string;
  asset_id: string;
  target_weight: number;
  current_value_usd?: number;
  avg_entry_price?: number | null;
  quantity?: number;
  /** Reasoning string built from CandidateScore.drivers. Pass `undefined`
   *  to keep the existing rationale; pass `null` to explicitly clear it. */
  rationale?: string | null;
}): void {
  // If rationale is undefined, preserve whatever's currently in the row.
  // If it's a string or explicit null, overwrite. We model this with a
  // COALESCE on update — pass a sentinel via parameter binding.
  const preserveRationale = p.rationale === undefined;
  db()
    .prepare(
      `INSERT INTO index_positions
         (index_id, asset_id, target_weight, current_value_usd,
          avg_entry_price, quantity, rationale, last_updated)
       VALUES (@index_id, @asset_id, @target_weight, @current_value_usd,
               @avg_entry_price, @quantity, @rationale, unixepoch() * 1000)
       ON CONFLICT(index_id, asset_id) DO UPDATE SET
         target_weight     = excluded.target_weight,
         current_value_usd = excluded.current_value_usd,
         avg_entry_price   = excluded.avg_entry_price,
         quantity          = excluded.quantity,
         rationale         = CASE WHEN @preserve_rationale = 1
                                  THEN index_positions.rationale
                                  ELSE excluded.rationale END,
         last_updated      = excluded.last_updated`,
    )
    .run({
      index_id: p.index_id,
      asset_id: p.asset_id,
      target_weight: p.target_weight,
      current_value_usd: p.current_value_usd ?? 0,
      avg_entry_price: p.avg_entry_price ?? null,
      quantity: p.quantity ?? 0,
      rationale: p.rationale ?? null,
      preserve_rationale: preserveRationale ? 1 : 0,
    });
}

export function clearZeroPositions(indexId: string, threshold = 0.0001): number {
  const r = db()
    .prepare(
      `DELETE FROM index_positions WHERE index_id = ? AND target_weight < ?`,
    )
    .run(indexId, threshold);
  return r.changes;
}

// ─────────────────────────────────────────────────────────────────────────
// Rebalances
// ─────────────────────────────────────────────────────────────────────────

export function insertRebalance(r: Omit<IndexRebalanceRow, "rebalanced_at"> & {
  rebalanced_at?: number;
}): void {
  db()
    .prepare(
      `INSERT INTO index_rebalances
         (id, index_id, rebalanced_at, triggered_by, pre_nav, post_nav,
          old_weights, new_weights, trades_made, reasoning, reviewer_model,
          framework_version)
       VALUES (@id, @index_id, @rebalanced_at, @triggered_by, @pre_nav, @post_nav,
               @old_weights, @new_weights, @trades_made, @reasoning, @reviewer_model,
               @framework_version)`,
    )
    .run({
      ...r,
      rebalanced_at: r.rebalanced_at ?? Date.now(),
      old_weights: JSON.stringify(r.old_weights),
      new_weights: JSON.stringify(r.new_weights),
      trades_made: JSON.stringify(r.trades_made),
      framework_version: r.framework_version ?? "v1",
    });
}

export function listRebalances(indexId: string, limit = 50): IndexRebalanceRow[] {
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
  const rows = db()
    .prepare<[string, number], Raw>(
      `SELECT * FROM index_rebalances
       WHERE index_id = ?
       ORDER BY rebalanced_at DESC
       LIMIT ?`,
    )
    .all(indexId, limit);
  return rows.map((r) => ({
    ...r,
    old_weights: JSON.parse(r.old_weights),
    new_weights: JSON.parse(r.new_weights),
    trades_made: JSON.parse(r.trades_made),
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// NAV history
// ─────────────────────────────────────────────────────────────────────────

export function snapshotNav(row: IndexNavRow): void {
  db()
    .prepare(
      `INSERT INTO index_nav_history (index_id, date, nav_usd, pnl_usd, pnl_pct, btc_price, ssimag7_price)
       VALUES (@index_id, @date, @nav_usd, @pnl_usd, @pnl_pct, @btc_price, @ssimag7_price)
       ON CONFLICT(index_id, date) DO UPDATE SET
         nav_usd       = excluded.nav_usd,
         pnl_usd       = excluded.pnl_usd,
         pnl_pct       = excluded.pnl_pct,
         btc_price     = excluded.btc_price,
         ssimag7_price = excluded.ssimag7_price`,
    )
    .run({
      ...row,
      btc_price: row.btc_price ?? null,
      ssimag7_price: row.ssimag7_price ?? null,
    });
}

export function listNavHistory(
  indexId: string,
  days = 90,
): IndexNavRow[] {
  return db()
    .prepare<[string, number], IndexNavRow>(
      `SELECT * FROM index_nav_history
       WHERE index_id = ?
       ORDER BY date DESC
       LIMIT ?`,
    )
    .all(indexId, days)
    .reverse();
}

// ─────────────────────────────────────────────────────────────────────────
// Signal P&L attribution (Part 3)
// ─────────────────────────────────────────────────────────────────────────

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

export function insertSignalAttribution(r: {
  id: string;
  index_id: string;
  rebalance_id: string;
  asof_ms: number;
  pre_nav_usd: number;
  weight_deltas_bps: Record<string, number>;
  sanity_ok: boolean;
  sanity_note?: string | null;
}): void {
  db()
    .prepare(
      `INSERT INTO signal_pnl_attribution
         (id, index_id, rebalance_id, asof_ms, pre_nav_usd,
          weight_deltas_bps, realized_pnl_usd, total_pnl_usd,
          sanity_ok, sanity_note)
       VALUES (@id, @index_id, @rebalance_id, @asof_ms, @pre_nav_usd,
               @weight_deltas_bps, NULL, NULL,
               @sanity_ok, @sanity_note)`,
    )
    .run({
      id: r.id,
      index_id: r.index_id,
      rebalance_id: r.rebalance_id,
      asof_ms: r.asof_ms,
      pre_nav_usd: r.pre_nav_usd,
      weight_deltas_bps: JSON.stringify(r.weight_deltas_bps),
      sanity_ok: r.sanity_ok ? 1 : 0,
      sanity_note: r.sanity_note ?? null,
    });
}

/** Mark an unresolved attribution row with realized P&L. */
export function resolveSignalAttribution(
  id: string,
  realized_pnl_usd: Record<string, number>,
  total_pnl_usd: number,
  resolved_at_ms: number,
): void {
  db()
    .prepare(
      `UPDATE signal_pnl_attribution
       SET realized_pnl_usd = @realized,
           total_pnl_usd    = @total,
           resolved_at      = @resolved_at
       WHERE id = @id`,
    )
    .run({
      id,
      realized: JSON.stringify(realized_pnl_usd),
      total: total_pnl_usd,
      resolved_at: resolved_at_ms,
    });
}

export function listSignalAttributions(
  indexId: string,
  limit = 30,
): SignalAttributionRow[] {
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
  const rows = db()
    .prepare<[string, number], Raw>(
      `SELECT * FROM signal_pnl_attribution
       WHERE index_id = ?
       ORDER BY asof_ms DESC
       LIMIT ?`,
    )
    .all(indexId, limit);
  return rows.map((r) => ({
    ...r,
    weight_deltas_bps: safeJson(r.weight_deltas_bps, {}),
    realized_pnl_usd: r.realized_pnl_usd ? safeJson(r.realized_pnl_usd, {}) : null,
    sanity_ok: r.sanity_ok === 1,
  }));
}

export function listUnresolvedAttributions(
  indexId: string,
): SignalAttributionRow[] {
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
  const rows = db()
    .prepare<[string], Raw>(
      `SELECT * FROM signal_pnl_attribution
       WHERE index_id = ? AND resolved_at IS NULL AND sanity_ok = 1
       ORDER BY asof_ms ASC`,
    )
    .all(indexId);
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
