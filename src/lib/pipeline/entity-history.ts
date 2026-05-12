/**
 * Stage 4 — Entity-history awareness.
 *
 * Each new signal is evaluated NOT in isolation but against the recent
 * narrative trajectory of its primary asset. Two mechanisms:
 *
 *   1. event_chain_id derivation: deterministic hash of (primary_asset,
 *      sorted_affected_assets, event_type, week_bucket). Two events
 *      that share a chain id are part of the same evolving story.
 *
 *   2. adjustConvictionForHistory: queries the asset's last 7 days of
 *      signals; if recent contradictory signals exist (different
 *      direction on the same asset), the new signal's conviction is
 *      reduced. Magnitude of reduction scales with recency × prior
 *      conviction.
 *
 * Real example fixed: WLFI tech_update LONG generated while WLFI is
 * concurrently subject of a bearish governance/fraud investigation
 * — the system used to evaluate each in isolation. Now the LONG
 * gets its conviction reduced because the recent bearish signal is
 * still on the same asset.
 *
 * Companion tests: tests/entity-history.test.ts
 */

import { createHash } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────
// event_chain_id derivation
// ─────────────────────────────────────────────────────────────────────────

interface ChainDeriveInput {
  primary_asset_id: string;
  affected_asset_ids: string[];
  event_type: string;
  release_time: number; // ms epoch
}

/**
 * Bucket events by ISO-week (Mon-Sun). Two events in the same week
 * with the same actor + same affected entities + same event_type
 * collapse to the same chain id.
 *
 * Chosen for buildathon scope: simpler than overlapping rolling
 * windows. Captures Kelp recovery saga (multi-day governance events
 * spanning a single week) cleanly.
 */
export function deriveEventChainId(input: ChainDeriveInput): string {
  const sortedAffected = [...new Set(input.affected_asset_ids)]
    .sort()
    .join(",");
  // ISO week bucket — week starting Monday.
  const d = new Date(input.release_time);
  // Get Thursday of the same week (ISO week anchors to Thursday).
  const dayUtc = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dayOfWeek = (dayUtc.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  dayUtc.setUTCDate(dayUtc.getUTCDate() - dayOfWeek + 3);
  const weekBucket = dayUtc.toISOString().slice(0, 10);

  const raw = [
    input.primary_asset_id,
    input.event_type,
    sortedAffected,
    weekBucket,
  ].join("|");
  return createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────
// adjustConvictionForHistory
// ─────────────────────────────────────────────────────────────────────────

export interface PriorSignalRecord {
  asset_id: string;
  direction: "long" | "short";
  conviction: number;
  fired_at: number;
  event_chain_id: string | null;
}

interface AdjustInput {
  new_direction: "long" | "short";
  new_conviction: number;
  primary_asset_id: string;
  /** Signal generator passes its candidate event_chain_id here. */
  new_event_chain_id?: string;
  /** Recent signals on the same asset, fetched by caller. */
  history: PriorSignalRecord[];
  /** Override "now" for tests. */
  now?: number;
}

export interface AdjustResult {
  adjusted_conviction: number;
  reason: string;
  is_chain_continuation: boolean;
  chained_to: PriorSignalRecord | null;
}

/**
 * Reduce a new signal's conviction if recent contradictory signals
 * exist on the same asset.
 *
 * Magnitude:
 *   - Reduction ranges from 0 (no effect) to 0.20 (severe).
 *   - Linear in (1 - age/7d) — older priors weigh less.
 *   - Linear in prior_conviction — a 0.85 prior contradicts harder
 *     than a 0.40 prior.
 *
 * Same-direction priors don't reduce — the system can re-affirm itself.
 */
export function adjustConvictionForHistory(
  input: AdjustInput,
): AdjustResult {
  const now = input.now ?? Date.now();
  const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;

  // Filter history to same-asset rows within 7d.
  const sameAsset = input.history.filter(
    (p) =>
      p.asset_id === input.primary_asset_id &&
      now - p.fired_at <= SEVEN_DAYS_MS,
  );

  // Detect chain continuation.
  const chainMatch =
    input.new_event_chain_id != null
      ? sameAsset.find((p) => p.event_chain_id === input.new_event_chain_id) ??
        null
      : null;
  const is_chain_continuation = chainMatch != null;

  // Find strongest contradictory recent signal.
  const contradictions = sameAsset.filter(
    (p) => p.direction !== input.new_direction,
  );
  if (contradictions.length === 0) {
    return {
      adjusted_conviction: input.new_conviction,
      reason: is_chain_continuation
        ? "same direction continuation; no contradiction"
        : "no contradicting history",
      is_chain_continuation,
      chained_to: chainMatch,
    };
  }
  // Strongest in terms of recency × conviction.
  let bestPenalty = 0;
  let bestPrior: PriorSignalRecord | null = null;
  for (const p of contradictions) {
    const ageRatio = Math.max(0, 1 - (now - p.fired_at) / SEVEN_DAYS_MS);
    const penalty = 0.2 * ageRatio * Math.min(1, Math.max(0, p.conviction));
    if (penalty > bestPenalty) {
      bestPenalty = penalty;
      bestPrior = p;
    }
  }
  const adjusted = Math.max(0, input.new_conviction - bestPenalty);
  return {
    adjusted_conviction: adjusted,
    reason: `contradicting prior ${bestPrior?.direction.toUpperCase()} on ${input.primary_asset_id} (conv ${bestPrior?.conviction.toFixed(2)}, ${Math.round(((now - (bestPrior?.fired_at ?? now)) / 3600 / 1000))}h ago) — penalty ${bestPenalty.toFixed(3)}`,
    is_chain_continuation,
    chained_to: chainMatch,
  };
}
