/**
 * Repository — `klines_daily`. Wave 2: async.
 */

import { all, get, batch } from "../client";
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

export async function upsertKlines(
  assetId: string,
  klines: Kline[],
): Promise<number> {
  if (klines.length === 0) return 0;
  const sql = `INSERT INTO klines_daily (asset_id, date, open, high, low, close, volume)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(asset_id, date) DO UPDATE SET
     open = excluded.open,
     high = excluded.high,
     low  = excluded.low,
     close = excluded.close,
     volume = excluded.volume`;
  await batch(
    klines.map((k) => ({
      sql,
      args: [
        assetId,
        formatApiDate(toMs(k.timestamp)),
        k.open ?? 0,
        k.high ?? 0,
        k.low ?? 0,
        k.close ?? 0,
        k.volume ?? 0,
      ],
    })),
  );
  return klines.length;
}

export async function getCloseAt(
  assetId: string,
  targetMs: number,
): Promise<{ date: string; close: number } | undefined> {
  return get<{ date: string; close: number }>(
    `SELECT date, close FROM klines_daily
     WHERE asset_id = ? AND date <= ?
     ORDER BY date DESC LIMIT 1`,
    [assetId, formatApiDate(targetMs)],
  );
}

export async function getKlines(
  assetId: string,
  opts?: { fromDate?: string; toDate?: string; limit?: number },
): Promise<StoredKline[]> {
  const fromDate = opts?.fromDate ?? "";
  const toDate = opts?.toDate ?? "";
  const limit = opts?.limit ?? 365;

  return all<StoredKline>(
    `SELECT * FROM klines_daily
     WHERE asset_id = ?
       AND (? = '' OR date >= ?)
       AND (? = '' OR date <= ?)
     ORDER BY date ASC
     LIMIT ?`,
    [assetId, fromDate, fromDate, toDate, toDate, limit],
  );
}
