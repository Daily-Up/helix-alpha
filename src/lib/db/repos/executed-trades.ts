/**
 * Repository — `executed_trades`.
 *
 * Helix-side audit log of live trades that users execute via SoDEX
 * directly from their browser. We never possess the API key secret;
 * this table only stores public metadata posted to us after the fact.
 */

import { all, run } from "../client";

export type TradeStatus = "submitted" | "filled" | "rejected";

export interface ExecutedTradeRow {
  id: string;
  user_wallet: string;
  signal_id: string | null;
  network: "mainnet" | "testnet";
  symbol: string;
  side: "buy" | "sell";
  size_usd: number | null;
  filled_price: number | null;
  filled_at: number;
  sodex_order_id: string | null;
  status: TradeStatus;
  error: string | null;
}

export async function insertExecutedTrade(
  row: ExecutedTradeRow,
): Promise<void> {
  await run(
    `INSERT OR REPLACE INTO executed_trades (
       id, user_wallet, signal_id, network, symbol, side,
       size_usd, filled_price, filled_at, sodex_order_id, status, error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.user_wallet.toLowerCase(),
      row.signal_id ?? null,
      row.network,
      row.symbol,
      row.side,
      row.size_usd ?? null,
      row.filled_price ?? null,
      row.filled_at,
      row.sodex_order_id ?? null,
      row.status,
      row.error ?? null,
    ],
  );
}

export async function listTradesForWallet(
  wallet: string,
  limit = 50,
): Promise<ExecutedTradeRow[]> {
  return all<ExecutedTradeRow>(
    `SELECT * FROM executed_trades
     WHERE user_wallet = ?
     ORDER BY filled_at DESC
     LIMIT ?`,
    [wallet.toLowerCase(), limit],
  );
}

export async function listTradesForSignal(
  signalId: string,
): Promise<ExecutedTradeRow[]> {
  return all<ExecutedTradeRow>(
    `SELECT * FROM executed_trades
     WHERE signal_id = ?
     ORDER BY filled_at DESC`,
    [signalId],
  );
}

export async function listRecentTrades(
  limit = 100,
): Promise<ExecutedTradeRow[]> {
  return all<ExecutedTradeRow>(
    `SELECT * FROM executed_trades
     ORDER BY filled_at DESC
     LIMIT ?`,
    [limit],
  );
}
