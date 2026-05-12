/**
 * Repository — `system_alerts` table (Part 3 — live deployment readiness).
 *
 * Lightweight: insert when a system condition crosses a threshold; list
 * unresolved on /system-health. A future task wires this to email/Telegram.
 */

import { db } from "../client";

export type AlertKind =
  | "job_stale"
  | "outcomes_stuck"
  | "classifier_errors"
  | "gate_spike"
  | "backup_failed";

export type AlertSeverity = "warn" | "error";

export interface AlertRow {
  id: number;
  raised_at: number;
  kind: AlertKind;
  severity: AlertSeverity;
  message: string;
  resolved_at: number | null;
}

export function raiseAlert(
  kind: AlertKind,
  severity: AlertSeverity,
  message: string,
): number {
  // Idempotency: don't double-raise an open alert of the same kind in
  // the last hour. Operators want to know when something is wrong, not
  // be paged 60 times for the same condition.
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const existing = db()
    .prepare<[AlertKind, number], { id: number }>(
      `SELECT id FROM system_alerts
       WHERE kind = ? AND resolved_at IS NULL AND raised_at >= ?
       ORDER BY raised_at DESC LIMIT 1`,
    )
    .get(kind, oneHourAgo);
  if (existing) return existing.id;

  const r = db()
    .prepare(
      `INSERT INTO system_alerts (raised_at, kind, severity, message)
       VALUES (?, ?, ?, ?)`,
    )
    .run(Date.now(), kind, severity, message);
  return Number(r.lastInsertRowid);
}

export function resolveAlerts(kind: AlertKind): number {
  return db()
    .prepare(
      `UPDATE system_alerts SET resolved_at = ?
       WHERE kind = ? AND resolved_at IS NULL`,
    )
    .run(Date.now(), kind).changes;
}

export function listOpenAlerts(): AlertRow[] {
  return db()
    .prepare<[], AlertRow>(
      `SELECT * FROM system_alerts WHERE resolved_at IS NULL ORDER BY raised_at DESC`,
    )
    .all();
}

export function listRecentAlerts(limit = 50): AlertRow[] {
  return db()
    .prepare<[number], AlertRow>(
      `SELECT * FROM system_alerts ORDER BY raised_at DESC LIMIT ?`,
    )
    .all(limit);
}
