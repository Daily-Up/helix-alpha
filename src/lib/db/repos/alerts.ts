/**
 * Repository — `system_alerts` table. Wave 2: async (libSQL/Turso).
 */

import { all, get, run } from "../client";

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

export async function raiseAlert(
  kind: AlertKind,
  severity: AlertSeverity,
  message: string,
): Promise<number> {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const existing = await get<{ id: number }>(
    `SELECT id FROM system_alerts
     WHERE kind = ? AND resolved_at IS NULL AND raised_at >= ?
     ORDER BY raised_at DESC LIMIT 1`,
    [kind, oneHourAgo],
  );
  if (existing) return existing.id;

  const r = await run(
    `INSERT INTO system_alerts (raised_at, kind, severity, message)
     VALUES (?, ?, ?, ?)`,
    [Date.now(), kind, severity, message],
  );
  return Number(r.lastInsertRowid);
}

export async function resolveAlerts(kind: AlertKind): Promise<number> {
  const r = await run(
    `UPDATE system_alerts SET resolved_at = ?
     WHERE kind = ? AND resolved_at IS NULL`,
    [Date.now(), kind],
  );
  return Number(r.rowsAffected);
}

export async function listOpenAlerts(): Promise<AlertRow[]> {
  return all<AlertRow>(
    `SELECT * FROM system_alerts WHERE resolved_at IS NULL ORDER BY raised_at DESC`,
  );
}

export async function listRecentAlerts(limit = 50): Promise<AlertRow[]> {
  return all<AlertRow>(
    `SELECT * FROM system_alerts ORDER BY raised_at DESC LIMIT ?`,
    [limit],
  );
}
