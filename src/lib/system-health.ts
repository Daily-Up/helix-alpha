/**
 * System health & live-deployment readiness. Wave 2: async.
 *
 * Hosted libSQL (Turso) means we no longer have a local file to back up
 * — the backup path now is a Turso DB export, which lives outside this
 * module. The runDatabaseBackup/pruneOldBackups APIs are kept as no-ops
 * for back-compat with the cron handler and tests.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { all, get, Alerts } from "@/lib/db";

export function isReadOnly(): boolean {
  return (process.env.READ_ONLY ?? "false").toLowerCase() === "true";
}

export interface GateRefusalCount {
  rule: string;
  count: number;
}

export interface SystemHealthSnapshot {
  last_classification_run: number | null;
  last_signal_gen_run: number | null;
  last_outcome_resolution_run: number | null;
  stuck_outcomes: number;
  recent_gate_refusals: GateRefusalCount[];
  recent_classifier_errors: number;
  db_size_bytes: number;
  read_only: boolean;
  dropped_headlines_24h: number;
  signals_created_24h: number;
  suppressed_signals_24h: number;
  supersessions_24h: number;
  skipped_pre_classify_24h: number;
  generated_at: number;
}

export async function buildSystemHealth(
  opts: { now_ms?: number } = {},
): Promise<SystemHealthSnapshot> {
  const now = opts.now_ms ?? Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const lastJob = async (jobName: string): Promise<number | null> => {
    const r = await get<{ ts: number | null }>(
      `SELECT MAX(finished_at) AS ts FROM cron_runs
       WHERE job = ? AND status = 'ok'`,
      [jobName],
    );
    return r?.ts ?? null;
  };

  const stuck =
    (await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM signal_outcomes
       WHERE outcome IS NULL AND expires_at < ?`,
      [now],
    ))?.n ?? 0;

  const refusals = await all<{ rule: string; count: number }>(
    `SELECT
       REPLACE(notes, 'blocked: ', '') AS rule,
       COUNT(*) AS count
     FROM signal_outcomes
     WHERE outcome = 'blocked' AND outcome_at >= ?
     GROUP BY rule
     ORDER BY count DESC`,
    [oneDayAgo],
  );

  const classErrors =
    (await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM cron_runs
       WHERE job = 'ingest_news' AND status != 'ok'
         AND started_at >= ?`,
      [oneHourAgo],
    ))?.n ?? 0;

  // Hosted DB — no local file size. Surface 0 so the dashboard renders.
  const dbSize = 0;

  const droppedHeadlines24h =
    (await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM dropped_headlines WHERE dropped_at >= ?`,
      [oneDayAgo],
    ))?.n ?? 0;
  const signalsCreated24h =
    (await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM signals WHERE fired_at >= ?`,
      [oneDayAgo],
    ))?.n ?? 0;
  const suppressed24h =
    (await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM suppressed_signals WHERE suppressed_at >= ?`,
      [oneDayAgo],
    ))?.n ?? 0;
  const supersessions24h =
    (await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM signal_supersessions WHERE superseded_at >= ?`,
      [oneDayAgo],
    ))?.n ?? 0;
  const skippedPreClassify24h =
    (await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM skipped_pre_classify WHERE skipped_at >= ?`,
      [oneDayAgo],
    ))?.n ?? 0;

  return {
    last_classification_run: await lastJob("ingest_news"),
    last_signal_gen_run: await lastJob("compute_patterns"),
    last_outcome_resolution_run: await lastJob("resolve_outcomes"),
    stuck_outcomes: stuck,
    recent_gate_refusals: refusals,
    recent_classifier_errors: classErrors,
    db_size_bytes: dbSize,
    read_only: isReadOnly(),
    dropped_headlines_24h: droppedHeadlines24h,
    signals_created_24h: signalsCreated24h,
    suppressed_signals_24h: suppressed24h,
    supersessions_24h: supersessions24h,
    skipped_pre_classify_24h: skippedPreClassify24h,
    generated_at: now,
  };
}

const JOB_INTERVALS_MIN: Record<string, number> = {
  ingest_news: 5,
  compute_patterns: 30,
  resolve_outcomes: 15,
  generate_briefing: 60 * 24,
};

export interface RaisedAlert {
  kind: "job_stale" | "outcomes_stuck" | "classifier_errors" | "gate_spike";
  severity: "warn" | "error";
  message: string;
}

export async function evaluateAlerts(
  opts: { now_ms?: number } = {},
): Promise<RaisedAlert[]> {
  const now = opts.now_ms ?? Date.now();
  const raised: RaisedAlert[] = [];

  for (const [job, intervalMin] of Object.entries(JOB_INTERVALS_MIN)) {
    const r = await get<{ ts: number | null }>(
      `SELECT MAX(finished_at) AS ts FROM cron_runs
       WHERE job = ? AND status = 'ok'`,
      [job],
    );
    if (r?.ts == null) continue;
    const ageMin = (now - r.ts) / 60000;
    if (ageMin > 2 * intervalMin) {
      const alert: RaisedAlert = {
        kind: "job_stale",
        severity: "warn",
        message: `${job} last ran ${Math.round(ageMin)}min ago (interval=${intervalMin}min)`,
      };
      await Alerts.raiseAlert(alert.kind, alert.severity, alert.message);
      raised.push(alert);
    }
  }

  const stuck =
    (await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM signal_outcomes
       WHERE outcome IS NULL AND expires_at < ?`,
      [now],
    ))?.n ?? 0;
  if (stuck > 10) {
    const alert: RaisedAlert = {
      kind: "outcomes_stuck",
      severity: "warn",
      message: `${stuck} outcomes pending past expiration — resolution job may be failing`,
    };
    await Alerts.raiseAlert(alert.kind, alert.severity, alert.message);
    raised.push(alert);
  }

  const oneHourAgo = now - 60 * 60 * 1000;
  const errsAndTotal = await get<{ errors: number; total: number }>(
    `SELECT
       SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors,
       COUNT(*) AS total
     FROM cron_runs
     WHERE job = 'ingest_news' AND started_at >= ?`,
    [oneHourAgo],
  );
  if (
    errsAndTotal &&
    errsAndTotal.total >= 4 &&
    errsAndTotal.errors / errsAndTotal.total > 0.05
  ) {
    const alert: RaisedAlert = {
      kind: "classifier_errors",
      severity: "error",
      message: `${errsAndTotal.errors}/${errsAndTotal.total} classifier runs errored in the last hour`,
    };
    await Alerts.raiseAlert(alert.kind, alert.severity, alert.message);
    raised.push(alert);
  }

  const trailingDay = now - 24 * 60 * 60 * 1000;
  const lastHourRefusals =
    (await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM signal_outcomes
       WHERE outcome = 'blocked' AND outcome_at >= ?`,
      [oneHourAgo],
    ))?.n ?? 0;
  const trailingDayRefusals =
    (await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM signal_outcomes
       WHERE outcome = 'blocked' AND outcome_at >= ? AND outcome_at < ?`,
      [trailingDay, oneHourAgo],
    ))?.n ?? 0;
  const baselinePerHour = trailingDayRefusals / 23;
  if (baselinePerHour > 0 && lastHourRefusals > 3 * baselinePerHour) {
    const alert: RaisedAlert = {
      kind: "gate_spike",
      severity: "warn",
      message: `gate refusals spiked: ${lastHourRefusals}/h vs ${baselinePerHour.toFixed(1)}/h trailing 24h baseline`,
    };
    await Alerts.raiseAlert(alert.kind, alert.severity, alert.message);
    raised.push(alert);
  }

  return raised;
}

// ─────────────────────────────────────────────────────────────────────────
// Backup — Wave 2 stub. Turso owns persistence; backups happen via the
// `turso db backups` CLI on a separate schedule. We keep the signatures so
// the existing cron handler + tests still compile.
// ─────────────────────────────────────────────────────────────────────────

export interface BackupResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export function runDatabaseBackup(opts: {
  backup_dir: string;
  now_ms?: number;
  source_path?: string;
}): BackupResult {
  void opts;
  return {
    ok: true,
    path: "(noop — Turso-managed; see `turso db backups`)",
  };
}

export function pruneOldBackups(opts: {
  backup_dir: string;
  now_ms?: number;
  retention_days?: number;
}): { deleted: number } {
  // Filesystem stub — only meaningful if there are local files to clean.
  if (!existsSync(opts.backup_dir)) return { deleted: 0 };
  const now = opts.now_ms ?? Date.now();
  const retentionDays = opts.retention_days ?? 30;
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;

  let deleted = 0;
  for (const name of readdirSync(opts.backup_dir)) {
    if (!name.endsWith(".db")) continue;
    const path = resolve(opts.backup_dir, name);
    try {
      const mtime = statSync(path).mtimeMs;
      if (mtime < cutoff) {
        rmSync(path);
        deleted++;
      }
    } catch {
      /* skip */
    }
  }
  void mkdirSync; // silence unused
  return { deleted };
}
