/**
 * Repository — `paper_trades` table. Wave 2: async.
 */

import { all, get, run } from "../client";

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

export async function insertTrade(t: NewPaperTrade): Promise<PaperTradeRow> {
  await run(
    `INSERT INTO paper_trades (
       id, signal_id, asset_id, sodex_symbol, direction,
       size_usd, entry_price, entry_time, stop_price, target_price,
       status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    [
      t.id,
      t.signal_id,
      t.asset_id,
      t.sodex_symbol,
      t.direction,
      t.size_usd,
      t.entry_price,
      t.entry_time,
      t.stop_price,
      t.target_price,
    ],
  );
  return (await getTrade(t.id))!;
}

export async function getTrade(
  id: string,
): Promise<PaperTradeRow | undefined> {
  return get<PaperTradeRow>("SELECT * FROM paper_trades WHERE id = ?", [id]);
}

export async function listOpen(): Promise<PaperTradeRow[]> {
  return all<PaperTradeRow>(
    "SELECT * FROM paper_trades WHERE status = 'open' ORDER BY entry_time DESC",
  );
}

export async function listAll(limit = 200): Promise<PaperTradeRow[]> {
  return all<PaperTradeRow>(
    "SELECT * FROM paper_trades ORDER BY entry_time DESC LIMIT ?",
    [limit],
  );
}

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

export async function closeTrade(
  id: string,
  exit_price: number,
  exit_reason: ExitReason,
): Promise<PaperTradeRow | undefined> {
  const t = await getTrade(id);
  if (!t || t.status === "closed") return t;
  const { pnl_usd, pnl_pct } = computePnl(
    t.direction,
    t.size_usd,
    t.entry_price,
    exit_price,
  );
  await run(
    `UPDATE paper_trades SET
       status = 'closed', exit_price = ?, exit_time = ?,
       exit_reason = ?, pnl_usd = ?, pnl_pct = ?
     WHERE id = ?`,
    [exit_price, Date.now(), exit_reason, pnl_usd, pnl_pct, id],
  );
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
  win_rate: number;
}

export async function portfolioStats(
  startingBalance: number,
  livePrices: Map<string, number>,
): Promise<PortfolioStats> {
  const closed = await all<{ pnl_usd: number; win: number }>(
    `SELECT pnl_usd, CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END AS win
     FROM paper_trades WHERE status = 'closed'`,
  );
  const realised = closed.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = closed.filter((r) => r.win === 1).length;

  const open = await listOpen();
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
