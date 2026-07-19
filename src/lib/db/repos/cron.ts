/**
 * Repository — `cron_runs` audit log.
 *
 * Every cron endpoint wraps its work in `recordRun(...)` so the dashboard
 * can show "last news ingest: 4 min ago, fetched 87 events".
 *
 * Wave 2: async (libSQL/Turso).
 */

import { all, get, run, getClient } from "../client";

export type JobName =
  | "ingest_news"
  | "classify_events"
  | "ingest_klines"
  | "ingest_etf_aggregate"
  | "ingest_etf_funds"
  | "snapshot_sectors"
  | "ingest_macro"
  | "compute_impact"
  | "compute_patterns"
  | "generate_briefing"
  | "ingest_btc_treasuries"
  | "ingest_unlocks"
  | "resolve_outcomes"
  | "backup_db"
  // Public-action rate-limit keys (recorded by /api/public/* endpoints
  // so the cron_runs table doubles as the rate-limit ledger).
  | "public_tick"
  | "public_generate_signals";

export interface CronRunRow {
  id: number;
  job: JobName;
  started_at: number;
  finished_at: number | null;
  status: "running" | "ok" | "error";
  summary: string | null;
  error: string | null;
}

/** Record a run from start to finish; returns the run id. */
export async function recordRun<T>(
  job: JobName,
  fn: () => Promise<{ summary: string; data?: T }>,
): Promise<{ id: number; summary: string; data?: T }> {
  const start = Date.now();
  const insert = await run(
    `INSERT INTO cron_runs (job, started_at, status) VALUES (?, ?, 'running')`,
    [job, start],
  );
  const id = Number(insert.lastInsertRowid);

  try {
    const { summary, data } = await fn();
    await run(
      `UPDATE cron_runs SET finished_at = ?, status = 'ok', summary = ? WHERE id = ?`,
      [Date.now(), summary, id],
    );
    return { id, summary, data };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    await run(
      `UPDATE cron_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?`,
      [Date.now(), msg.slice(0, 1000), id],
    );
    throw err;
  }
}

export async function lastRun(
  job: JobName,
): Promise<CronRunRow | undefined> {
  return get<CronRunRow>(
    `SELECT * FROM cron_runs WHERE job = ? ORDER BY started_at DESC LIMIT 1`,
    [job],
  );
}

export async function recentRuns(limit = 50): Promise<CronRunRow[]> {
  return all<CronRunRow>(
    `SELECT * FROM cron_runs ORDER BY started_at DESC LIMIT ?`,
    [limit],
  );
}

// Silence unused-import warning — getClient kept for any future direct use.
void getClient;
