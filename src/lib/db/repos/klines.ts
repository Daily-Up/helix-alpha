/**
 * Repository — `klines_daily`.
 *
 * Bulk-store daily OHLCV from /currencies/{id}/klines. The impact engine
 * reads this to compute price moves around event timestamps.
 */

import { db } from "../client";
import { toMs, type Kline } from "@/lib/sosovalue";
import { formatApiDate } from "@/lib/sosovalue";

export interface StoredKline {
  asset_id: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function upsertKlines(assetId: string, klines: Kline[]): number {
  if (klines.length === 0) return 0;
  const stmt = db().prepare(
    `INSERT INTO klines_daily (asset_id, date, open, high, low, close, volume)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset_id, date) DO UPDATE SET
       open = excluded.open,
       high = excluded.high,
       low  = excluded.low,
       close = excluded.close,
       volume = excluded.volume`,
  );
  const tx = db().transaction((rows: Kline[]) => {
    let n = 0;
    for (const k of rows) {
      const date = formatApiDate(toMs(k.timestamp));
      stmt.run(assetId, date, k.open, k.high, k.low, k.close, k.volume);
      n++;
    }
    return n;
  });
  return tx(klines);
}

/** Get the close price closest to (but not after) a target timestamp. */
export function getCloseAt(
  assetId: string,
  targetMs: number,
): { date: string; close: number } | undefined {
  const row = db()
    .prepare<[string, string], { date: string; close: number }>(
      `SELECT date, close FROM klines_daily
       WHERE asset_id = ? AND date <= ?
       ORDER BY date DESC LIMIT 1`,
    )
    .get(assetId, formatApiDate(targetMs));
  return row;
}

/** Range query for charts. */
export function getKlines(
  assetId: string,
  opts?: { fromDate?: string; toDate?: string; limit?: number },
): StoredKline[] {
  const fromDate = opts?.fromDate ?? "";
  const toDate = opts?.toDate ?? "";
  const limit = opts?.limit ?? 365;

  const rows = db()
    .prepare<
      [string, string, string, string, string, number],
      StoredKline
    >(
      `SELECT * FROM klines_daily
       WHERE asset_id = ?
         AND (? = '' OR date >= ?)
         AND (? = '' OR date <= ?)
       ORDER BY date ASC
       LIMIT ?`,
    )
    .all(assetId, fromDate, fromDate, toDate, toDate, limit);
  return rows;
}
