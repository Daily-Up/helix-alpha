/**
 * Repository — `signal_outcomes` table.
 *
 * Three write paths:
 *   1. `insertOutcomeFromSignal` — at signal-fire time, copies known
 *      fields from the just-inserted signals row + asset_class + price.
 *      outcome=NULL until the resolution job runs.
 *   2. `markOutcomeDismissed` — set outcome='dismissed' immediately.
 *   3. `insertBlockedOutcome` — gate refusal; the signal_id is the
 *      would-have-been id and outcome='blocked' from the start.
 *
 * Read paths:
 *   - `listPendingOutcomes` — what the 15-min resolution job iterates.
 *   - `getOutcomeBySignalId` — UI / audit.
 *
 * Update path:
 *   - `applyResolution` — sets outcome/price_at_outcome/realized_pct.
 *
 * Invariants: I-30 (PIPELINE_INVARIANTS.md).
 */

import { db } from "../client";

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

// ─────────────────────────────────────────────────────────────────────────
// Write: signal-fire time
// ─────────────────────────────────────────────────────────────────────────

export interface InsertFromSignalInput {
  signal_id: string;
  /** Asset-class string from `classifyAssetClass`, or "unknown" when null. */
  asset_class: string;
  /** Catalyst-time price; null when asset isn't priceable. */
  price_at_generation: number | null;
}

/**
 * Look up the persisted signal and copy the snapshot fields into a new
 * outcome row with outcome=NULL. Used inside the same transaction as the
 * signal insert (per I-30) so the two are atomic.
 *
 * Throws if the signal row doesn't exist — caller's transaction rolls back.
 */
export function insertOutcomeFromSignal(input: InsertFromSignalInput): void {
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
  const sig = db()
    .prepare<[string], SigRow>(
      `SELECT asset_id, direction, tier, confidence, catalyst_subtype,
              fired_at, expires_at, expected_horizon,
              suggested_stop_pct, suggested_target_pct
       FROM signals WHERE id = ?`,
    )
    .get(input.signal_id);
  if (!sig) {
    throw new Error(
      `insertOutcomeFromSignal: no signals row for ${input.signal_id}`,
    );
  }

  const horizonHours = horizonStringToHours(sig.expected_horizon ?? "24h");
  const expiresAt =
    sig.expires_at ?? sig.fired_at + horizonHours * 3600 * 1000;

  // Look up the framework that's currently active. Outcomes are tagged
  // with the framework that was live when the signal fired so the
  // calibration dashboard can split them by framework (Part 1 of v2.1
  // attribution). Falls back to 'v1' when the setting is missing.
  const fwRow = db()
    .prepare<[], { value: string }>(
      `SELECT value FROM user_settings WHERE key = 'index_framework_version'`,
    )
    .get();
  const frameworkVersion = fwRow?.value ?? "v1";

  db()
    .prepare(
      `INSERT INTO signal_outcomes (
         signal_id, asset_id, direction, catalyst_subtype, asset_class,
         tier, conviction,
         generated_at, horizon_hours, expires_at,
         price_at_generation, target_pct, stop_pct,
         outcome, recorded_at, framework_version
       ) VALUES (
         @signal_id, @asset_id, @direction, @catalyst_subtype, @asset_class,
         @tier, @conviction,
         @generated_at, @horizon_hours, @expires_at,
         @price_at_generation, @target_pct, @stop_pct,
         NULL, @recorded_at, @framework_version
       )`,
    )
    .run({
      signal_id: input.signal_id,
      asset_id: sig.asset_id,
      direction: sig.direction,
      catalyst_subtype: sig.catalyst_subtype ?? "other",
      asset_class: input.asset_class,
      tier: sig.tier,
      conviction: sig.confidence,
      generated_at: sig.fired_at,
      horizon_hours: horizonHours,
      expires_at: expiresAt,
      price_at_generation: input.price_at_generation,
      target_pct: sig.suggested_target_pct ?? 0,
      stop_pct: sig.suggested_stop_pct ?? 0,
      recorded_at: Date.now(),
      framework_version: frameworkVersion,
    });
}

/** Has an outcome row been recorded for this signal? Used by I-30 gate. */
export function outcomeExistsFor(signalId: string): boolean {
  const r = db()
    .prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM signal_outcomes WHERE signal_id = ?`,
    )
    .get(signalId);
  return (r?.n ?? 0) > 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Write: shadow outcome (Part 2 of v2.1 attribution gap-closing — I-40)
//
// Shadow outcomes mirror live outcomes for the SAME signal under the
// non-active framework's risk parameters. They share metadata
// (asset, catalyst_subtype, direction, conviction, generated_at) with
// the live outcome but use framework-specific stop/target levels and
// are tagged with the shadow framework_version.
//
// Identity: synthetic signal_id = `${signal_id}-shadow-${framework}`
// avoids the existing PK on signal_outcomes.signal_id while keeping
// the relationship to the source signal traceable.
// INSERT OR IGNORE makes it idempotent — running shadow rebalance
// twice in the same cycle is a no-op.
// ─────────────────────────────────────────────────────────────────────────

export interface RecordShadowOutcomeInput {
  signal_id: string;
  framework_version: "v1" | "v2";
  asset_class: string;
  price_at_generation: number | null;
  /** Framework-specific stop/target — may differ from the signal's own. */
  target_pct: number;
  stop_pct: number;
}

export function recordShadowOutcomeFromSignal(
  input: RecordShadowOutcomeInput,
): void {
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
  const sig = db()
    .prepare<[string], SigRow>(
      `SELECT asset_id, direction, tier, confidence, catalyst_subtype,
              fired_at, expires_at, expected_horizon
       FROM signals WHERE id = ?`,
    )
    .get(input.signal_id);
  if (!sig) {
    // The signal may have been GC'd; skip silently rather than throw.
    // Shadow attribution is observability, not a load-bearing path.
    return;
  }
  const horizonHours = horizonStringToHours(sig.expected_horizon ?? "24h");
  const expiresAt = sig.expires_at ?? sig.fired_at + horizonHours * 3600 * 1000;
  const shadowId = `${input.signal_id}-shadow-${input.framework_version}`;

  db()
    .prepare(
      `INSERT OR IGNORE INTO signal_outcomes (
         signal_id, asset_id, direction, catalyst_subtype, asset_class,
         tier, conviction,
         generated_at, horizon_hours, expires_at,
         price_at_generation, target_pct, stop_pct,
         outcome, recorded_at, framework_version
       ) VALUES (
         @signal_id, @asset_id, @direction, @catalyst_subtype, @asset_class,
         @tier, @conviction,
         @generated_at, @horizon_hours, @expires_at,
         @price_at_generation, @target_pct, @stop_pct,
         NULL, @recorded_at, @framework_version
       )`,
    )
    .run({
      signal_id: shadowId,
      asset_id: sig.asset_id,
      direction: sig.direction,
      catalyst_subtype: sig.catalyst_subtype ?? "other",
      asset_class: input.asset_class,
      tier: sig.tier,
      conviction: sig.confidence,
      generated_at: sig.fired_at,
      horizon_hours: horizonHours,
      expires_at: expiresAt,
      price_at_generation: input.price_at_generation,
      target_pct: input.target_pct,
      stop_pct: input.stop_pct,
      recorded_at: Date.now(),
      framework_version: input.framework_version,
    });
}

// ─────────────────────────────────────────────────────────────────────────
// Write: dismiss / block
// ─────────────────────────────────────────────────────────────────────────

export function markOutcomeDismissed(signalId: string, note?: string): void {
  db()
    .prepare(
      `UPDATE signal_outcomes
       SET outcome = 'dismissed',
           outcome_at = ?,
           notes = COALESCE(notes, '') || ?
       WHERE signal_id = ? AND outcome IS NULL`,
    )
    .run(Date.now(), note ? `dismissed: ${note}` : "dismissed", signalId);
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
  /** Pre-save gate rule that fired (e.g. 'mechanism_conviction_excess'). */
  rule: string;
}

/**
 * Insert a row with outcome='blocked' to record what the gate caught.
 * Useful for operations: when the gate refuses signals at a higher rate
 * than usual, that's a sign upstream is leaking.
 */
export function insertBlockedOutcome(input: InsertBlockedInput): void {
  db()
    .prepare(
      `INSERT OR IGNORE INTO signal_outcomes (
         signal_id, asset_id, direction, catalyst_subtype, asset_class,
         tier, conviction,
         generated_at, horizon_hours, expires_at,
         price_at_generation, target_pct, stop_pct,
         outcome, outcome_at, notes, recorded_at
       ) VALUES (
         @signal_id, @asset_id, @direction, @catalyst_subtype, @asset_class,
         @tier, @conviction,
         @generated_at, @horizon_hours, @expires_at,
         @price_at_generation, @target_pct, @stop_pct,
         'blocked', @outcome_at, @notes, @recorded_at
       )`,
    )
    .run({
      signal_id: input.signal_id,
      asset_id: input.asset_id,
      direction: input.direction,
      catalyst_subtype: input.catalyst_subtype,
      asset_class: input.asset_class,
      tier: input.tier,
      conviction: input.conviction,
      generated_at: input.generated_at,
      horizon_hours: input.horizon_hours,
      expires_at: input.expires_at,
      price_at_generation: input.price_at_generation,
      target_pct: input.target_pct,
      stop_pct: input.stop_pct,
      outcome_at: Date.now(),
      notes: `blocked: ${input.rule}`,
      recorded_at: Date.now(),
    });
}

// ─────────────────────────────────────────────────────────────────────────
// Read: pending list + lookup
// ─────────────────────────────────────────────────────────────────────────

/** Rows the resolution job will revisit. */
export function listPendingOutcomes(): OutcomeRow[] {
  return db()
    .prepare<[], OutcomeRow>(
      `SELECT * FROM signal_outcomes WHERE outcome IS NULL ORDER BY generated_at ASC`,
    )
    .all();
}

export function getOutcomeBySignalId(signalId: string): OutcomeRow | undefined {
  return db()
    .prepare<[string], OutcomeRow>(
      `SELECT * FROM signal_outcomes WHERE signal_id = ?`,
    )
    .get(signalId);
}

// ─────────────────────────────────────────────────────────────────────────
// Update: resolution
// ─────────────────────────────────────────────────────────────────────────

export interface ResolutionUpdate {
  outcome: OutcomeStatus;
  outcome_at_ms: number;
  price_at_outcome: number | null;
  realized_pct: number | null;
}

export function applyResolution(
  signalId: string,
  update: ResolutionUpdate,
): void {
  // realized_pnl_usd = realized_pct% × suggested_size_usd. We pull size
  // from the parent signal row in a single query so callers don't need
  // to plumb it through.
  const size = db()
    .prepare<[string], { size: number | null }>(
      `SELECT suggested_size_usd AS size FROM signals WHERE id = ?`,
    )
    .get(signalId);
  const sizeUsd = size?.size ?? null;
  const pnl =
    update.realized_pct != null && sizeUsd != null
      ? (update.realized_pct / 100) * sizeUsd
      : null;

  db()
    .prepare(
      `UPDATE signal_outcomes
       SET outcome = ?, outcome_at = ?, price_at_outcome = ?,
           realized_pct = ?, realized_pnl_usd = ?
       WHERE signal_id = ? AND outcome IS NULL`,
    )
    .run(
      update.outcome,
      update.outcome_at_ms,
      update.price_at_outcome,
      update.realized_pct,
      pnl,
      signalId,
    );
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Parse a horizon string like "4h", "24h", "3d", "5d" → hours. */
export function horizonStringToHours(s: string): number {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)([hd])$/i);
  if (!m) return 24;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "d") return Math.round(n * 24);
  return Math.round(n);
}
