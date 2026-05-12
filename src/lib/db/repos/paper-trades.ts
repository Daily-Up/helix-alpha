/**
 * Repository — `paper_trades` table.
 *
 * Simulated positions opened from accepted signals. Real SoDEX prices,
 * simulated fills. P&L tracked by polling SoDEX tickers.
 */

import { db } from "../client";

export type TradeDirection = "long" | "short";
export type TradeStatus = "open" | "closed";
export type ExitReason = "target" | "stop" | "manual" | "timeout";

export interface PaperTradeRow {
  id: string;
  signal_id: string | null;
  asset_id: string;
  sodex_symbol: string;
  direction: TradeDirection;
  size_usd: number;
  entry_price: number;
  entry_time: number;
  stop_price: number | null;
  target_price: number | null;
  exit_price: number | null;
  exit_time: number | null;
  exit_reason: ExitReason | null;
  pnl_usd: number | null;
  pnl_pct: number | null;
  status: TradeStatus;
}

export type NewPaperTrade = Omit<
  PaperTradeRow,
  | "exit_price"
  | "exit_time"
  | "exit_reason"
  | "pnl_usd"
  | "pnl_pct"
  | "status"
>;

export function insertTrade(t: NewPaperTrade): PaperTradeRow {
  db()
    .prepare(
      `INSERT INTO paper_trades (
         id, signal_id, asset_id, sodex_symbol, direction,
         size_usd, entry_price, entry_time, stop_price, target_price,
         status
       ) VALUES (
         @id, @signal_id, @asset_id, @sodex_symbol, @direction,
         @size_usd, @entry_price, @entry_time, @stop_price, @target_price,
         'open'
       )`,
    )
    .run(t);
  return getTrade(t.id)!;
}

export function getTrade(id: string): PaperTradeRow | undefined {
  return db()
    .prepare<[string], PaperTradeRow>(
      "SELECT * FROM paper_trades WHERE id = ?",
    )
    .get(id);
}

export function listOpen(): PaperTradeRow[] {
  return db()
    .prepare<[], PaperTradeRow>(
      "SELECT * FROM paper_trades WHERE status = 'open' ORDER BY entry_time DESC",
    )
    .all();
}

export function listAll(limit = 200): PaperTradeRow[] {
  return db()
    .prepare<[number], PaperTradeRow>(
      "SELECT * FROM paper_trades ORDER BY entry_time DESC LIMIT ?",
    )
    .all(limit);
}

/**
 * Compute P&L given an exit price and direction.
 *   long  P&L = (exit - entry) / entry * size
 *   short P&L = (entry - exit) / entry * size
 */
export function computePnl(
  direction: TradeDirection,
  size_usd: number,
  entry_price: number,
  exit_price: number,
): { pnl_usd: number; pnl_pct: number } {
  const move = (exit_price - entry_price) / entry_price;
  const pct_signed = direction === "long" ? move : -move;
  return {
    pnl_usd: size_usd * pct_signed,
    pnl_pct: pct_signed * 100,
  };
}

export function closeTrade(
  id: string,
  exit_price: number,
  exit_reason: ExitReason,
): PaperTradeRow | undefined {
  const t = getTrade(id);
  if (!t || t.status === "closed") return t;
  const { pnl_usd, pnl_pct } = computePnl(
    t.direction,
    t.size_usd,
    t.entry_price,
    exit_price,
  );
  db()
    .prepare(
      `UPDATE paper_trades SET
         status = 'closed', exit_price = ?, exit_time = ?,
         exit_reason = ?, pnl_usd = ?, pnl_pct = ?
       WHERE id = ?`,
    )
    .run(exit_price, Date.now(), exit_reason, pnl_usd, pnl_pct, id);
  return getTrade(id);
}

export interface PortfolioStats {
  starting_balance: number;
  realised_pnl: number;
  unrealised_pnl: number;
  equity: number;
  open_positions: number;
  closed_trades: number;
  winning_trades: number;
  win_rate: number; // 0..1
}

/**
 * Compute portfolio stats. `livePrices` lets you mark-to-market open positions.
 */
export function portfolioStats(
  startingBalance: number,
  livePrices: Map<string, number>,
): PortfolioStats {
  const closed = db()
    .prepare<[], { pnl_usd: number; win: number }>(
      `SELECT pnl_usd, CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END AS win
       FROM paper_trades WHERE status = 'closed'`,
    )
    .all();
  const realised = closed.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = closed.filter((r) => r.win === 1).length;

  const open = listOpen();
  let unrealised = 0;
  for (const t of open) {
    const px = livePrices.get(t.sodex_symbol);
    if (px == null) continue;
    const { pnl_usd } = computePnl(
      t.direction,
      t.size_usd,
      t.entry_price,
      px,
    );
    unrealised += pnl_usd;
  }

  return {
    starting_balance: startingBalance,
    realised_pnl: realised,
    unrealised_pnl: unrealised,
    equity: startingBalance + realised + unrealised,
    open_positions: open.length,
    closed_trades: closed.length,
    winning_trades: wins,
    win_rate: closed.length === 0 ? 0 : wins / closed.length,
  };
}
