/**
 * Stage 6b — emission-time strict conflict + live supersession (Phase D/E).
 *
 * Invariants:
 *   I-42 (strict conflict): same-asset opposite-direction pending signals
 *        whose windows overlap by ≥ 50% with both asset_relevance ≥ 0.6
 *        cannot both persist. Higher significance wins; tiebreak by
 *        conviction, then by recency. Loser → suppressed_signals.
 *   I-43 (supersession): when the new winner's significance is ≥ 1.5×
 *        the standing loser's significance, the standing signal's status
 *        flips pending → superseded and a signal_supersessions row records
 *        the ratio + reason.
 *
 * Pure logic in this module — DB writes happen in the caller (signal
 * generator) so transactions stay coherent and tests can drive it without
 * a DB. Companion tests:
 *   - tests/strict-conflict-resolution.test.ts
 *   - tests/signal-supersession.test.ts
 */

export const CONFLICT_RELEVANCE_FLOOR = 0.6;
export const OVERLAP_THRESHOLD = 0.5;
export const SUPERSESSION_RATIO_THRESHOLD = 1.5;

export interface ConflictCandidate {
  /** signal id; existing candidates have a real id, new ones can use any string */
  id: string;
  direction: "long" | "short";
  asset_id: string;
  /** fired_at for existing / generated_at for new */
  start_at: number;
  /** original window end — never extended by supersession */
  expires_at: number;
  asset_relevance: number;
  significance_score: number;
  /** Conviction (axes total); used as tiebreaker. */
  conviction: number;
}

export type ConflictVerdict =
  | { kind: "no_conflict" }
  | {
      kind: "suppress_new";
      reason: string;
      winner_id: string;
      loser_significance: number;
      winner_significance: number;
    }
  | {
      kind: "suppress_existing";
      reason: string;
      loser_id: string;
      loser_significance: number;
      winner_significance: number;
    }
  | {
      kind: "supersede_existing";
      reason: string;
      loser_id: string;
      loser_significance: number;
      winner_significance: number;
      ratio: number;
    };

/**
 * Compute the fraction of the new window that overlaps the existing window.
 * Range [0, 1]. Zero when they don't intersect or either window has
 * non-positive length. The "≥ 50% overlap" gate uses this against
 * OVERLAP_THRESHOLD.
 */
export function windowOverlapFraction(
  a: { start_at: number; expires_at: number },
  b: { start_at: number; expires_at: number },
): number {
  const newLen = Math.max(0, a.expires_at - a.start_at);
  if (newLen <= 0) return 0;
  const overlapStart = Math.max(a.start_at, b.start_at);
  const overlapEnd = Math.min(a.expires_at, b.expires_at);
  const overlapLen = Math.max(0, overlapEnd - overlapStart);
  return overlapLen / newLen;
}

/**
 * Compare two candidates and produce a verdict per the I-42/I-43 rules.
 * `newCand` is the incoming candidate (not yet persisted); `existing` is
 * the standing pending signal. Both have already been confirmed to be on
 * the same asset.
 */
export function resolveConflict(
  newCand: ConflictCandidate,
  existing: ConflictCandidate,
): ConflictVerdict {
  // Same direction → not a conflict (handled by existing dedup paths).
  if (newCand.direction === existing.direction) {
    return { kind: "no_conflict" };
  }
  // Relevance floor — either side below 0.6 → ignore. The pair is too
  // weakly anchored to either asset to count as contradiction.
  if (
    newCand.asset_relevance < CONFLICT_RELEVANCE_FLOOR ||
    existing.asset_relevance < CONFLICT_RELEVANCE_FLOOR
  ) {
    return { kind: "no_conflict" };
  }
  // Window overlap floor — need ≥ 50% to count as competing for the same
  // forward window. Use the new signal's window as the denominator so a
  // long-horizon existing doesn't drown out a short-horizon new.
  const overlap = windowOverlapFraction(newCand, existing);
  if (overlap < OVERLAP_THRESHOLD) {
    return { kind: "no_conflict" };
  }

  // Supersession check first — if the new signal dominates by ≥ 1.5×,
  // it's an explicit retire-the-old ceremony (Phase E, I-43). Treat
  // existing.significance_score = 0 as 'always dominated' to keep the
  // ratio finite.
  const denom = existing.significance_score || 1e-9;
  const ratio = newCand.significance_score / denom;
  if (
    newCand.significance_score >= existing.significance_score &&
    ratio >= SUPERSESSION_RATIO_THRESHOLD
  ) {
    return {
      kind: "supersede_existing",
      reason: `new significance ${newCand.significance_score.toFixed(3)} / existing ${existing.significance_score.toFixed(3)} = ${ratio.toFixed(2)}× (≥ ${SUPERSESSION_RATIO_THRESHOLD}× threshold)`,
      loser_id: existing.id,
      loser_significance: existing.significance_score,
      winner_significance: newCand.significance_score,
      ratio,
    };
  }

  // Strict conflict (Phase D, I-42). Higher significance wins; ties
  // within 0.05 broken by conviction, then by recency (newer wins).
  const sigDiff = newCand.significance_score - existing.significance_score;
  if (Math.abs(sigDiff) > 0.05) {
    if (sigDiff > 0) {
      // New wins → suppress existing.
      return {
        kind: "suppress_existing",
        reason: `new significance ${newCand.significance_score.toFixed(3)} > existing ${existing.significance_score.toFixed(3)} on opposite direction`,
        loser_id: existing.id,
        loser_significance: existing.significance_score,
        winner_significance: newCand.significance_score,
      };
    }
    return {
      kind: "suppress_new",
      reason: `existing significance ${existing.significance_score.toFixed(3)} > new ${newCand.significance_score.toFixed(3)} on opposite direction`,
      winner_id: existing.id,
      loser_significance: newCand.significance_score,
      winner_significance: existing.significance_score,
    };
  }

  // Significance tie → break by conviction.
  const convDiff = newCand.conviction - existing.conviction;
  if (Math.abs(convDiff) > 1e-6) {
    if (convDiff > 0) {
      return {
        kind: "suppress_existing",
        reason: `significance tie within 0.05; new conviction ${newCand.conviction.toFixed(3)} > existing ${existing.conviction.toFixed(3)}`,
        loser_id: existing.id,
        loser_significance: existing.significance_score,
        winner_significance: newCand.significance_score,
      };
    }
    return {
      kind: "suppress_new",
      reason: `significance tie within 0.05; existing conviction ${existing.conviction.toFixed(3)} ≥ new ${newCand.conviction.toFixed(3)}`,
      winner_id: existing.id,
      loser_significance: newCand.significance_score,
      winner_significance: existing.significance_score,
    };
  }

  // Total tie → newer wins.
  return {
    kind: "suppress_existing",
    reason: `significance + conviction tie; newer signal wins`,
    loser_id: existing.id,
    loser_significance: existing.significance_score,
    winner_significance: newCand.significance_score,
  };
}
