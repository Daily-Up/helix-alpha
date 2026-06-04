/**
 * Repository — `signal_outcomes` table. Wave 2: async.
 */

import { all, get, run } from "../client";

export type OutcomeStatus =
  | "target_hit"
  | "stop_hit"
  | "flat"
  | "dismissed"
  | "blocked";

export interface OutcomeRow {
  signal_id: string;
  asset_id: string;
  direction: "long" | "short";
  catalyst_subtype: string;
  asset_class: string;
  tier: "auto" | "review" | "info";
  conviction: number;
  generated_at: number;
  horizon_hours: number;
  expires_at: number;
  price_at_generation: number | null;
  target_pct: number;
  stop_pct: number;
  outcome: OutcomeStatus | null;
  outcome_at: number | null;
  price_at_outcome: number | null;
  realized_pct: number | null;
  realized_pnl_usd: number | null;
  notes: string | null;
  recorded_at: number;
}

export interface InsertFromSignalInput {
  signal_id: string;
  asset_class: string;
  price_at_generation: number | null;
}

export async function insertOutcomeFromSignal(
  input: InsertFromSignalInput,
): Promise<void> {
  interface SigRow {
    asset_id: string;
    direction: "long" | "short";
    tier: "auto" | "review" | "info";
    confidence: number;
    catalyst_subtype: string | null;
    fired_at: number;
    expires_at: number | null;
    expected_horizon: string | null;
    suggested_stop_pct: number | null;
    suggested_target_pct: number | null;
  }
  const sig = await get<SigRow>(
    `SELECT asset_id, direction, tier, confidence, catalyst_subtype,
            fired_at, expires_at, expected_horizon,
            suggested_stop_pct, suggested_target_pct
     FROM signals WHERE id = ?`,
    [input.signal_id],
  );
  if (!sig) {
    throw new Error(
      `insertOutcomeFromSignal: no signals row for ${input.signal_id}`,
    );
  }

  const horizonHours = horizonStringToHours(sig.expected_horizon ?? "24h");
  const expiresAt =
    sig.expires_at ?? sig.fired_at + horizonHours * 3600 * 1000;

  const fwRow = await get<{ value: string }>(
    `SELECT value FROM user_settings WHERE key = 'index_framework_version'`,
  );
  const frameworkVersion = fwRow?.value ?? "v1";

  await run(
    `INSERT INTO signal_outcomes (
       signal_id, asset_id, direction, catalyst_subtype, asset_class,
       tier, conviction,
       generated_at, horizon_hours, expires_at,
       price_at_generation, target_pct, stop_pct,
       outcome, recorded_at, framework_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      input.signal_id,
      sig.asset_id,
      sig.direction,
      sig.catalyst_subtype ?? "other",
      input.asset_class,
      sig.tier,
      sig.confidence,
      sig.fired_at,
      horizonHours,
      expiresAt,
      input.price_at_generation,
      sig.suggested_target_pct ?? 0,
      sig.suggested_stop_pct ?? 0,
      Date.now(),
      frameworkVersion,
    ],
  );
}

export async function outcomeExistsFor(signalId: string): Promise<boolean> {
  const r = await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM signal_outcomes WHERE signal_id = ?`,
    [signalId],
  );
  return (r?.n ?? 0) > 0;
}

export interface RecordShadowOutcomeInput {
  signal_id: string;
  framework_version: "v1" | "v2";
  asset_class: string;
  price_at_generation: number | null;
  target_pct: number;
  stop_pct: number;
}

export async function recordShadowOutcomeFromSignal(
  input: RecordShadowOutcomeInput,
): Promise<void> {
  interface SigRow {
    asset_id: string;
    direction: "long" | "short";
    tier: "auto" | "review" | "info";
    confidence: number;
    catalyst_subtype: string | null;
    fired_at: number;
    expires_at: number | null;
    expected_horizon: string | null;
  }
  const sig = await get<SigRow>(
    `SELECT asset_id, direction, tier, confidence, catalyst_subtype,
            fired_at, expires_at, expected_horizon
     FROM signals WHERE id = ?`,
    [input.signal_id],
  );
  if (!sig) return;
  const horizonHours = horizonStringToHours(sig.expected_horizon ?? "24h");
  const expiresAt = sig.expires_at ?? sig.fired_at + horizonHours * 3600 * 1000;
  const shadowId = `${input.signal_id}-shadow-${input.framework_version}`;

  await run(
    `INSERT OR IGNORE INTO signal_outcomes (
       signal_id, asset_id, direction, catalyst_subtype, asset_class,
       tier, conviction,
       generated_at, horizon_hours, expires_at,
       price_at_generation, target_pct, stop_pct,
       outcome, recorded_at, framework_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      shadowId,
      sig.asset_id,
      sig.direction,
      sig.catalyst_subtype ?? "other",
      input.asset_class,
      sig.tier,
      sig.confidence,
      sig.fired_at,
      horizonHours,
      expiresAt,
      input.price_at_generation,
      input.target_pct,
      input.stop_pct,
      Date.now(),
      input.framework_version,
    ],
  );
}

export async function markOutcomeDismissed(
  signalId: string,
  note?: string,
): Promise<void> {
  await run(
    `UPDATE signal_outcomes
     SET outcome = 'dismissed',
         outcome_at = ?,
         notes = COALESCE(notes, '') || ?
     WHERE signal_id = ? AND outcome IS NULL`,
    [Date.now(), note ? `dismissed: ${note}` : "dismissed", signalId],
  );
}

export interface InsertBlockedInput {
  signal_id: string;
  asset_id: string;
  asset_class: string;
  direction: "long" | "short";
  tier: "auto" | "review" | "info";
  conviction: number;
  catalyst_subtype: string;
  generated_at: number;
  horizon_hours: number;
  expires_at: number;
  price_at_generation: number | null;
  target_pct: number;
  stop_pct: number;
  rule: string;
}

export async function insertBlockedOutcome(
  input: InsertBlockedInput,
): Promise<void> {
  await run(
    `INSERT OR IGNORE INTO signal_outcomes (
       signal_id, asset_id, direction, catalyst_subtype, asset_class,
       tier, conviction,
       generated_at, horizon_hours, expires_at,
       price_at_generation, target_pct, stop_pct,
       outcome, outcome_at, notes, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'blocked', ?, ?, ?)`,
    [
      input.signal_id,
      input.asset_id,
      input.direction,
      input.catalyst_subtype,
      input.asset_class,
      input.tier,
      input.conviction,
      input.generated_at,
      input.horizon_hours,
      input.expires_at,
      input.price_at_generation,
      input.target_pct,
      input.stop_pct,
      Date.now(),
      `blocked: ${input.rule}`,
      Date.now(),
    ],
  );
}

export async function listPendingOutcomes(): Promise<OutcomeRow[]> {
  return all<OutcomeRow>(
    `SELECT * FROM signal_outcomes WHERE outcome IS NULL ORDER BY generated_at ASC`,
  );
}

export async function getOutcomeBySignalId(
  signalId: string,
): Promise<OutcomeRow | undefined> {
  return get<OutcomeRow>(
    `SELECT * FROM signal_outcomes WHERE signal_id = ?`,
    [signalId],
  );
}

export interface ResolutionUpdate {
  outcome: OutcomeStatus;
  outcome_at_ms: number;
  price_at_outcome: number | null;
  realized_pct: number | null;
}

export async function applyResolution(
  signalId: string,
  update: ResolutionUpdate,
): Promise<void> {
  const size = await get<{ size: number | null }>(
    `SELECT suggested_size_usd AS size FROM signals WHERE id = ?`,
    [signalId],
  );
  const sizeUsd = size?.size ?? null;
  const pnl =
    update.realized_pct != null && sizeUsd != null
      ? (update.realized_pct / 100) * sizeUsd
      : null;

  await run(
    `UPDATE signal_outcomes
     SET outcome = ?, outcome_at = ?, price_at_outcome = ?,
         realized_pct = ?, realized_pnl_usd = ?
     WHERE signal_id = ? AND outcome IS NULL`,
    [
      update.outcome,
      update.outcome_at_ms,
      update.price_at_outcome,
      update.realized_pct,
      pnl,
      signalId,
    ],
  );
}

/**
 * Like `applyResolution` but without the "outcome IS NULL" guard.
 *
 * Use only for re-resolving FLAT outcomes that were locked in when the
 * kline window was empty (klines_daily lagged the resolution job, so
 * the resolver fell through to `flat` with `price_at_outcome=NULL` and
 * `realized_pct=0`). Now that klines_daily is fresh, recomputing those
 * rows lets the at-expiry directional close-to-close ROI surface on the
 * performance page instead of a misleading "0%".
 *
 * Refuses to overwrite `target_hit` / `stop_hit` / `blocked` /
 * `dismissed` — those are real, not artefacts of stale data.
 */
export async function recomputeFlatResolution(
  signalId: string,
  update: ResolutionUpdate,
): Promise<void> {
  const size = await get<{ size: number | null }>(
    `SELECT suggested_size_usd AS size FROM signals WHERE id = ?`,
    [signalId],
  );
  const sizeUsd = size?.size ?? null;
  const pnl =
    update.realized_pct != null && sizeUsd != null
      ? (update.realized_pct / 100) * sizeUsd
      : null;

  await run(
    `UPDATE signal_outcomes
     SET outcome = ?, outcome_at = ?, price_at_outcome = ?,
         realized_pct = ?, realized_pnl_usd = ?
     WHERE signal_id = ? AND outcome = 'flat'`,
    [
      update.outcome,
      update.outcome_at_ms,
      update.price_at_outcome,
      update.realized_pct,
      pnl,
      signalId,
    ],
  );
}

/**
 * Rows whose `outcome='flat'` was decided before klines_daily had any
 * bar covering the signal window — the row has no `price_at_outcome`
 * (and therefore `realized_pct=0` is a placeholder, not a real flat).
 *
 * `recomputeFlatOutcomesJob` re-resolves these once klines are fresh.
 */
export async function listFlatOutcomesMissingPrice(): Promise<OutcomeRow[]> {
  return all<OutcomeRow>(
    `SELECT * FROM signal_outcomes
     WHERE outcome = 'flat' AND price_at_outcome IS NULL
     ORDER BY generated_at ASC`,
  );
}

export function horizonStringToHours(s: string): number {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)([hd])$/i);
  if (!m) return 24;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "d") return Math.round(n * 24);
  return Math.round(n);
}
