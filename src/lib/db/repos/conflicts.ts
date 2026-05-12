/**
 * Repos for emission-time conflict + supersession audit (Phase D/E).
 *
 *   - suppressed_signals (I-42): the loser of a strict-conflict comparison
 *     at emission. Either the new signal (it never inserts into `signals`)
 *     or an existing pending signal (its status flips to 'suppressed').
 *   - signal_supersessions (I-43): explicit retirement when the new
 *     signal's significance is ≥ 1.5× the standing signal's significance.
 */

import { randomUUID } from "node:crypto";
import { db } from "../client";

// ─────────────────────────────────────────────────────────────────────────
// suppressed_signals
// ─────────────────────────────────────────────────────────────────────────

export interface SuppressedSignalRow {
  id: string;
  suppressed_signal_data: string;
  reason: string;
  conflicting_signal_id: string;
  significance_loser: number;
  significance_winner: number;
  suppressed_at: number;
}

export function insertSuppressedSignal(input: {
  suppressed_signal_data: unknown;
  reason: string;
  conflicting_signal_id: string;
  significance_loser: number;
  significance_winner: number;
}): string {
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO suppressed_signals
         (id, suppressed_signal_data, reason, conflicting_signal_id,
          significance_loser, significance_winner)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      JSON.stringify(input.suppressed_signal_data),
      input.reason,
      input.conflicting_signal_id,
      input.significance_loser,
      input.significance_winner,
    );
  return id;
}

export function listSuppressionsForConflict(
  signalId: string,
): SuppressedSignalRow[] {
  return db()
    .prepare<[string], SuppressedSignalRow>(
      `SELECT * FROM suppressed_signals
       WHERE conflicting_signal_id = ?
       ORDER BY suppressed_at DESC`,
    )
    .all(signalId);
}

// ─────────────────────────────────────────────────────────────────────────
// signal_supersessions
// ─────────────────────────────────────────────────────────────────────────

export interface SignalSupersessionRow {
  id: string;
  superseded_signal_id: string;
  superseding_signal_id: string;
  significance_ratio: number;
  reason: string;
  superseded_at: number;
}

export function insertSupersession(input: {
  superseded_signal_id: string;
  superseding_signal_id: string;
  significance_ratio: number;
  reason: string;
}): string {
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO signal_supersessions
         (id, superseded_signal_id, superseding_signal_id,
          significance_ratio, reason)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.superseded_signal_id,
      input.superseding_signal_id,
      input.significance_ratio,
      input.reason,
    );
  return id;
}

export function getSupersessionForOld(
  supersededId: string,
): SignalSupersessionRow | undefined {
  return db()
    .prepare<[string], SignalSupersessionRow>(
      `SELECT * FROM signal_supersessions WHERE superseded_signal_id = ?`,
    )
    .get(supersededId);
}

export function listSupersessionsByNew(
  supersedingId: string,
): SignalSupersessionRow[] {
  return db()
    .prepare<[string], SignalSupersessionRow>(
      `SELECT * FROM signal_supersessions
       WHERE superseding_signal_id = ?
       ORDER BY superseded_at DESC`,
    )
    .all(supersedingId);
}
