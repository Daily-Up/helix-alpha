/**
 * equity_snapshots repo — the portfolio equity curve's backing store.
 *
 * SoDEX has no equity/PnL-history endpoint, so we record current equity per
 * connected address over time and read the series back for the chart. Writes
 * are throttled by the caller (one row / 15 min / address) via `latest()`.
 */

import { all, get, run } from "@/lib/db";

export interface EquitySnapshotRow {
  id: number;
  address: string;
  ts: number;
  perps_equity: number;
  spot_equity: number;
  total_equity: number;
  perps_upnl: number | null;
  spot_upnl: number | null;
}

export interface NewEquitySnapshot {
  address: string;
  ts: number;
  perps_equity: number;
  spot_equity: number;
  total_equity: number;
  perps_upnl?: number | null;
  spot_upnl?: number | null;
}

/** Addresses are stored lowercase so a checksummed vs lowercase 0x never splits
 *  one account's curve across two rows. */
const norm = (a: string) => a.trim().toLowerCase();

export async function insert(row: NewEquitySnapshot): Promise<void> {
  await run(
    `INSERT INTO equity_snapshots
       (address, ts, perps_equity, spot_equity, total_equity, perps_upnl, spot_upnl)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      norm(row.address),
      row.ts,
      row.perps_equity,
      row.spot_equity,
      row.total_equity,
      row.perps_upnl ?? null,
      row.spot_upnl ?? null,
    ],
  );
}

/** Newest snapshot for an address (for the write throttle + "history starts"). */
export async function latest(
  address: string,
): Promise<EquitySnapshotRow | undefined> {
  return get<EquitySnapshotRow>(
    `SELECT * FROM equity_snapshots WHERE address = ? ORDER BY ts DESC LIMIT 1`,
    [norm(address)],
  );
}

/** The oldest snapshot for an address — powers the "History starts <date>" note. */
export async function earliest(
  address: string,
): Promise<EquitySnapshotRow | undefined> {
  return get<EquitySnapshotRow>(
    `SELECT * FROM equity_snapshots WHERE address = ? ORDER BY ts ASC LIMIT 1`,
    [norm(address)],
  );
}

/** Ascending snapshot series for an address since `sinceMs` (0 = all history). */
export async function series(
  address: string,
  sinceMs: number,
): Promise<EquitySnapshotRow[]> {
  return all<EquitySnapshotRow>(
    `SELECT * FROM equity_snapshots
     WHERE address = ? AND ts >= ?
     ORDER BY ts ASC`,
    [norm(address), sinceMs],
  );
}

/** Distinct addresses with any snapshot in the window — for the daily cron
 *  backstop to know which recently-active accounts to re-snapshot. */
export async function activeAddresses(sinceMs: number): Promise<string[]> {
  const rows = await all<{ address: string }>(
    `SELECT DISTINCT address FROM equity_snapshots WHERE ts >= ?`,
    [sinceMs],
  );
  return rows.map((r) => r.address);
}
