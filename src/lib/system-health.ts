/**
 * System health & live-deployment readiness — Part 3.
 *
 * Three pieces:
 *   1. `buildSystemHealth(now)` — snapshot for /system-health UI.
 *   2. `evaluateAlerts(now)` — check thresholds and raise alerts.
 *   3. `runDatabaseBackup` + `pruneOldBackups` — nightly DB copy with
 *      30-day retention.
 *
 * Plus:
 *   - `READ_ONLY` flag (env-driven) — disables signal generation while
 *     keeping the dashboard + outcome resolution running.
 *
 * Companion tests: tests/system-health.test.ts.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { db, Alerts } from "@/lib/db";
import { env } from "@/lib/env";

// ─────────────────────────────────────────────────────────────────────────
// READ_ONLY mode
// ─────────────────────────────────────────────────────────────────────────

/**
 * When true, disable signal generation. Outcome resolution + dashboards
 * keep running so we can observe the existing queue without churning new
 * signals during a maintenance window.
 *
 * Set via env: `READ_ONLY=true npm run dev` (or in production env vars).
 * Reads on each call so flipping the flag at runtime takes effect on the
 * next tick.
 */
export function isReadOnly(): boolean {
  return (process.env.READ_ONLY ?? "false").toLowerCase() === "true";
}

// ─────────────────────────────────────────────────────────────────────────
// Snapshot
// ─────────────────────────────────────────────────────────────────────────

export interface GateRefusalCount {
  rule: string;
  count: number;
}

export interface SystemHealthSnapshot {
  /** Last successful row in cron_runs for each job; null if never run. */
  last_classification_run: number | null;
  last_signal_gen_run: number | null;
  last_outcome_resolution_run: number | null;
  /** Outcomes with outcome IS NULL AND expires_at < now. Should be 0. */
  stuck_outcomes: number;
  /** Gate refusals from the last 24h, grouped by rule. */
  recent_gate_refusals: GateRefusalCount[];
  /** Classifier errors in cron_runs over last hour. */
  recent_classifier_errors: number;
  /** sqlite file size; for capacity planning. */
  db_size_bytes: number;
  /** Whether READ_ONLY is on. */
  read_only: boolean;
  /** Phase C — significance drop rate over the last 24h. */
  dropped_headlines_24h: number;
  /** Phase C — pending signals that survived the significance gate. */
  signals_created_24h: number;
  /** Phase D — strict-conflict suppressions over the last 24h. */
  suppressed_signals_24h: number;
  /** Phase E — supersessions fired over the last 24h. */
  supersessions_24h: number;
  /** Phase G — pre-classify drops by the corpus gate over the last 24h. */
  skipped_pre_classify_24h: number;
  generated_at: number;
}

/**
 * Build a system-health snapshot. Pure-ish: accesses the DB but not
 * external services. Fast — should respond in <100ms even on a large DB.
 */
export function buildSystemHealth(
  opts: { now_ms?: number } = {},
): SystemHealthSnapshot {
  const now = opts.now_ms ?? Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const lastJob = (jobName: string): number | null => {
    const r = db()
      .prepare<[string], { ts: number | null }>(
        `SELECT MAX(finished_at) AS ts FROM cron_runs
         WHERE job = ? AND status = 'ok'`,
      )
      .get(jobName);
    return r?.ts ?? null;
  };

  const stuck =
    db()
      .prepare<[number], { n: number }>(
        `SELECT COUNT(*) AS n FROM signal_outcomes
         WHERE outcome IS NULL AND expires_at < ?`,
      )
      .get(now)?.n ?? 0;

  const refusals = db()
    .prepare<[number], { rule: string; count: number }>(
      `SELECT
         /* notes is "blocked: <rule>". Strip the prefix to group cleanly. */
         REPLACE(notes, 'blocked: ', '') AS rule,
         COUNT(*) AS count
       FROM signal_outcomes
       WHERE outcome = 'blocked' AND outcome_at >= ?
       GROUP BY rule
       ORDER BY count DESC`,
    )
    .all(oneDayAgo);

  const classErrors =
    db()
      .prepare<[number], { n: number }>(
        `SELECT COUNT(*) AS n FROM cron_runs
         WHERE job = 'ingest_news' AND status != 'ok'
           AND started_at >= ?`,
      )
      .get(oneHourAgo)?.n ?? 0;

  const dbSize = dbFileSizeBytes();

  const droppedHeadlines24h =
    db()
      .prepare<[number], { n: number }>(
        `SELECT COUNT(*) AS n FROM dropped_headlines WHERE dropped_at >= ?`,
      )
      .get(oneDayAgo)?.n ?? 0;
  const signalsCreated24h =
    db()
      .prepare<[number], { n: number }>(
        `SELECT COUNT(*) AS n FROM signals WHERE fired_at >= ?`,
      )
      .get(oneDayAgo)?.n ?? 0;
  const suppressed24h =
    db()
      .prepare<[number], { n: number }>(
        `SELECT COUNT(*) AS n FROM suppressed_signals WHERE suppressed_at >= ?`,
      )
      .get(oneDayAgo)?.n ?? 0;
  const supersessions24h =
    db()
      .prepare<[number], { n: number }>(
        `SELECT COUNT(*) AS n FROM signal_supersessions WHERE superseded_at >= ?`,
      )
      .get(oneDayAgo)?.n ?? 0;
  const skippedPreClassify24h =
    db()
      .prepare<[number], { n: number }>(
        `SELECT COUNT(*) AS n FROM skipped_pre_classify WHERE skipped_at >= ?`,
      )
      .get(oneDayAgo)?.n ?? 0;

  return {
    last_classification_run: lastJob("ingest_news"),
    last_signal_gen_run: lastJob("compute_patterns"),
    last_outcome_resolution_run: lastJob("resolve_outcomes"),
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

function dbFileSizeBytes(): number {
  try {
    const path = resolve(process.cwd(), env.DATABASE_PATH);
    if (!existsSync(path)) return 0;
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Alerts
// ─────────────────────────────────────────────────────────────────────────

/** Job intervals in minutes — drives the staleness threshold. */
const JOB_INTERVALS_MIN: Record<string, number> = {
  ingest_news: 5,
  compute_patterns: 30,
  resolve_outcomes: 15,
  generate_briefing: 60 * 24, // daily
};

export interface RaisedAlert {
  kind: "job_stale" | "outcomes_stuck" | "classifier_errors" | "gate_spike";
  severity: "warn" | "error";
  message: string;
}

/**
 * Evaluate the alert thresholds. Idempotent — `Alerts.raiseAlert`
 * coalesces duplicates within an hour. Returns the alerts raised so
 * callers can log / surface them.
 */
export function evaluateAlerts(
  opts: { now_ms?: number } = {},
): RaisedAlert[] {
  const now = opts.now_ms ?? Date.now();
  const raised: RaisedAlert[] = [];

  // 1. job_stale: any job hasn't run in > 2× its interval.
  for (const [job, intervalMin] of Object.entries(JOB_INTERVALS_MIN)) {
    const r = db()
      .prepare<[string], { ts: number | null }>(
        `SELECT MAX(finished_at) AS ts FROM cron_runs
         WHERE job = ? AND status = 'ok'`,
      )
      .get(job);
    if (r?.ts == null) continue; // never ran — don't alert at boot
    const ageMin = (now - r.ts) / 60000;
    if (ageMin > 2 * intervalMin) {
      const alert: RaisedAlert = {
        kind: "job_stale",
        severity: "warn",
        message: `${job} last ran ${Math.round(ageMin)}min ago (interval=${intervalMin}min)`,
      };
      Alerts.raiseAlert(alert.kind, alert.severity, alert.message);
      raised.push(alert);
    }
  }

  // 2. outcomes_stuck: > 10 outcomes in NULL state past expiration.
  const stuck =
    db()
      .prepare<[number], { n: number }>(
        `SELECT COUNT(*) AS n FROM signal_outcomes
         WHERE outcome IS NULL AND expires_at < ?`,
      )
      .get(now)?.n ?? 0;
  if (stuck > 10) {
    const alert: RaisedAlert = {
      kind: "outcomes_stuck",
      severity: "warn",
      message: `${stuck} outcomes pending past expiration — resolution job may be failing`,
    };
    Alerts.raiseAlert(alert.kind, alert.severity, alert.message);
    raised.push(alert);
  }

  // 3. classifier_errors: > 5% error rate in last hour. We approximate
  //    by counting non-ok ingest_news runs in the last hour vs total.
  const oneHourAgo = now - 60 * 60 * 1000;
  const errsAndTotal = db()
    .prepare<[number], { errors: number; total: number }>(
      `SELECT
         SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors,
         COUNT(*) AS total
       FROM cron_runs
       WHERE job = 'ingest_news' AND started_at >= ?`,
    )
    .get(oneHourAgo);
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
    Alerts.raiseAlert(alert.kind, alert.severity, alert.message);
    raised.push(alert);
  }

  // 4. gate_spike: refusals in last hour > 3× the trailing 24h baseline.
  const trailingDay = now - 24 * 60 * 60 * 1000;
  const lastHourRefusals =
    db()
      .prepare<[number], { n: number }>(
        `SELECT COUNT(*) AS n FROM signal_outcomes
         WHERE outcome = 'blocked' AND outcome_at >= ?`,
      )
      .get(oneHourAgo)?.n ?? 0;
  const trailingDayRefusals =
    db()
      .prepare<[number, number], { n: number }>(
        `SELECT COUNT(*) AS n FROM signal_outcomes
         WHERE outcome = 'blocked' AND outcome_at >= ? AND outcome_at < ?`,
      )
      .get(trailingDay, oneHourAgo)?.n ?? 0;
  // 24h average per hour — multiply by 3 for the threshold.
  const baselinePerHour = trailingDayRefusals / 23;
  if (baselinePerHour > 0 && lastHourRefusals > 3 * baselinePerHour) {
    const alert: RaisedAlert = {
      kind: "gate_spike",
      severity: "warn",
      message: `gate refusals spiked: ${lastHourRefusals}/h vs ${baselinePerHour.toFixed(1)}/h trailing 24h baseline`,
    };
    Alerts.raiseAlert(alert.kind, alert.severity, alert.message);
    raised.push(alert);
  }

  return raised;
}

// ─────────────────────────────────────────────────────────────────────────
// Backup
// ─────────────────────────────────────────────────────────────────────────

export interface BackupResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * Copy the active SQLite file to `<backup_dir>/sosoalpha-YYYY-MM-DD.db`.
 * Idempotent within a day — the same date filename is overwritten.
 *
 * Note: uses `copyFileSync` rather than `.backup()` API. For our
 * single-writer setup this is safe; in production with concurrent writes
 * we'd want the SQLite backup API for an online snapshot.
 */
export function runDatabaseBackup(opts: {
  backup_dir: string;
  now_ms?: number;
  /** Override DB source path; default is `env.DATABASE_PATH`. Used by
   *  tests to point at a sentinel file without touching env. */
  source_path?: string;
}): BackupResult {
  const now = opts.now_ms ?? Date.now();
  try {
    const dbPath =
      opts.source_path ?? resolve(process.cwd(), env.DATABASE_PATH);
    if (!existsSync(dbPath)) {
      return { ok: false, error: `db file not found: ${dbPath}` };
    }
    if (!existsSync(opts.backup_dir)) {
      mkdirSync(opts.backup_dir, { recursive: true });
    }
    const dateStr = new Date(now).toISOString().slice(0, 10);
    const target = resolve(opts.backup_dir, `sosoalpha-${dateStr}.db`);
    copyFileSync(dbPath, target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Delete backup files older than the retention window (default 30 days).
 * Uses the file's mtime for age — the daily `runDatabaseBackup` updates
 * mtime on every copy so this is reliable.
 */
export function pruneOldBackups(opts: {
  backup_dir: string;
  now_ms?: number;
  retention_days?: number;
}): { deleted: number } {
  const now = opts.now_ms ?? Date.now();
  const retentionDays = opts.retention_days ?? 30;
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  if (!existsSync(opts.backup_dir)) return { deleted: 0 };

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
      /* skip files we can't stat */
    }
  }
  return { deleted };
}
