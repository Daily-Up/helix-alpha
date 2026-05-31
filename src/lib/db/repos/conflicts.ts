/**
 * Repos for emission-time conflict + supersession audit. Wave 2: async.
 */

import { randomUUID } from "node:crypto";
import { all, get, run } from "../client";

export interface SuppressedSignalRow {
  id: string;
  suppressed_signal_data: string;
  reason: string;
  conflicting_signal_id: string;
  significance_loser: number;
  significance_winner: number;
  suppressed_at: number;
}

export async function insertSuppressedSignal(input: {
  suppressed_signal_data: unknown;
  reason: string;
  conflicting_signal_id: string;
  significance_loser: number;
  significance_winner: number;
}): Promise<string> {
  const id = randomUUID();
  await run(
    `INSERT INTO suppressed_signals
       (id, suppressed_signal_data, reason, conflicting_signal_id,
        significance_loser, significance_winner)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      JSON.stringify(input.suppressed_signal_data),
      input.reason,
      input.conflicting_signal_id,
      input.significance_loser,
      input.significance_winner,
    ],
  );
  return id;
}

export async function listSuppressionsForConflict(
  signalId: string,
): Promise<SuppressedSignalRow[]> {
  return all<SuppressedSignalRow>(
    `SELECT * FROM suppressed_signals
     WHERE conflicting_signal_id = ?
     ORDER BY suppressed_at DESC`,
    [signalId],
  );
}

export interface SignalSupersessionRow {
  id: string;
  superseded_signal_id: string;
  superseding_signal_id: string;
  significance_ratio: number;
  reason: string;
  superseded_at: number;
}

export async function insertSupersession(input: {
  superseded_signal_id: string;
  superseding_signal_id: string;
  significance_ratio: number;
  reason: string;
}): Promise<string> {
  const id = randomUUID();
  await run(
    `INSERT INTO signal_supersessions
       (id, superseded_signal_id, superseding_signal_id,
        significance_ratio, reason)
     VALUES (?, ?, ?, ?, ?)`,
    [
      id,
      input.superseded_signal_id,
      input.superseding_signal_id,
      input.significance_ratio,
      input.reason,
    ],
  );
  return id;
}

export async function getSupersessionForOld(
  supersededId: string,
): Promise<SignalSupersessionRow | undefined> {
  return get<SignalSupersessionRow>(
    `SELECT * FROM signal_supersessions WHERE superseded_signal_id = ?`,
    [supersededId],
  );
}

export async function listSupersessionsByNew(
  supersedingId: string,
): Promise<SignalSupersessionRow[]> {
  return all<SignalSupersessionRow>(
    `SELECT * FROM signal_supersessions
     WHERE superseding_signal_id = ?
     ORDER BY superseded_at DESC`,
    [supersedingId],
  );
}
