/**
 * Repository — `cron_runs` audit log.
 *
 * Every cron endpoint wraps its work in `recordRun(...)` so the dashboard
 * can show "last news ingest: 4 min ago, fetched 87 events".
 */

import { db } from "../client";

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
  // Part 1: outcome resolution job (every cron tick).
  | "resolve_outcomes"
  // Part 3: nightly DB backup.
  | "backup_db";

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
  const insert = db()
    .prepare(
      `INSERT INTO cron_runs (job, started_at, status) VALUES (?, ?, 'running')`,
    )
    .run(job, start);
  const id = Number(insert.lastInsertRowid);

  try {
    const { summary, data } = await fn();
    db()
      .prepare(
        `UPDATE cron_runs SET finished_at = ?, status = 'ok', summary = ? WHERE id = ?`,
      )
      .run(Date.now(), summary, id);
    return { id, summary, data };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    db()
      .prepare(
        `UPDATE cron_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?`,
      )
      .run(Date.now(), msg.slice(0, 1000), id);
    throw err;
  }
}

export function lastRun(job: JobName): CronRunRow | undefined {
  return db()
    .prepare<[JobName], CronRunRow>(
      `SELECT * FROM cron_runs WHERE job = ? ORDER BY started_at DESC LIMIT 1`,
    )
    .get(job);
}

export function recentRuns(limit = 50): CronRunRow[] {
  return db()
    .prepare<[number], CronRunRow>(
      `SELECT * FROM cron_runs ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit);
}
