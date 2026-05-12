/**
 * Stage 5.5 — Price-already-moved check (Dimension 2).
 *
 * For every signal we compute `realized_fraction` — what fraction of
 * the EXPECTED move (from base rates) the underlying asset has already
 * absorbed since the catalyst was published. The Coinbase Q1 miss
 * signal that fired SHORT after the stock was already down 9% is the
 * canonical bad case: by the time the signal fired, the alpha was
 * gone.
 *
 *   realized_move    = (current - catalyst_time_price) / catalyst_time_price,
 *                      signed by predicted direction.
 *   expected_move    = base-rate `mean_move_pct` for (subtype, asset_class)
 *                      OR fallback (existing target_pct from riskFromBaseRate).
 *   realized_fraction = realized_move / expected_move.
 *
 * Verdict thresholds (per task spec):
 *   > 1.0  → drop entirely (`move_exhausted`)
 *   > 0.6  → cap to INFO    (`move_largely_realized`)
 *   < -0.3 → drop entirely (`market_disagrees`)
 *   else   → proceed
 *
 * This module is two pieces:
 *   - `computeRealizedFraction()` — pure function on prices, easy to test
 *   - `applyRealizedMoveCap()`     — verdict + downgrade target
 *
 * The pre-save gate enforces the same thresholds as a fallback so
 * upstream callers can't skip them.
 *
 * Companion tests: tests/price-realization.test.ts.
 *
 * Invariants: I-26 (PIPELINE_INVARIANTS.md).
 */

export interface RealizedFractionInput {
  direction: "long" | "short";
  /** Asset spot price at the time the catalyst was published. */
  catalyst_price: number | null;
  /** Asset spot price RIGHT NOW. */
  current_price: number | null;
  /**
   * Expected absolute move size in percent. Comes from base_rates.json
   * mean_move_pct OR (when base rate missing) the riskFromBaseRate
   * target_pct fallback. Must be > 0.
   */
  expected_move_pct: number | null;
}

/**
 * Compute realized_fraction. Returns null when prices or expected move
 * are unavailable — caller treats null as "skip the check, log
 * `price_check_unavailable`" rather than blocking on missing data.
 */
export function computeRealizedFraction(
  input: RealizedFractionInput,
): number | null {
  if (
    input.catalyst_price == null ||
    input.current_price == null ||
    input.catalyst_price <= 0 ||
    input.expected_move_pct == null ||
    input.expected_move_pct <= 0
  ) {
    return null;
  }
  // Raw % move from catalyst publish to now.
  const rawMove =
    ((input.current_price - input.catalyst_price) / input.catalyst_price) *
    100;
  // Sign by predicted direction: long expects +rawMove, short expects -rawMove.
  const directional = input.direction === "long" ? rawMove : -rawMove;
  return directional / input.expected_move_pct;
}

// ─────────────────────────────────────────────────────────────────────────
// Verdict
// ─────────────────────────────────────────────────────────────────────────

export type RealizedMoveVerdict = "proceed" | "downgrade" | "drop";

export interface RealizedMoveCapInput {
  realized_fraction: number | null;
  tier: "auto" | "review" | "info";
}

export interface RealizedMoveCapResult {
  verdict: RealizedMoveVerdict;
  tier: "auto" | "review" | "info";
  reason:
    | "move_exhausted"
    | "move_largely_realized"
    | "market_disagrees"
    | "price_check_unavailable"
    | null;
}

/**
 * Apply the verdict. Pure function — caller decides whether to skip the
 * signal entirely or downgrade the tier.
 */
export function applyRealizedMoveCap(
  input: RealizedMoveCapInput,
): RealizedMoveCapResult {
  if (input.realized_fraction == null) {
    return {
      verdict: "proceed",
      tier: input.tier,
      reason: "price_check_unavailable",
    };
  }
  if (input.realized_fraction > 1.0) {
    return {
      verdict: "drop",
      tier: input.tier,
      reason: "move_exhausted",
    };
  }
  if (input.realized_fraction < -0.3) {
    return {
      verdict: "drop",
      tier: input.tier,
      reason: "market_disagrees",
    };
  }
  if (input.realized_fraction > 0.6) {
    return {
      verdict: "downgrade",
      tier: "info",
      reason: "move_largely_realized",
    };
  }
  return { verdict: "proceed", tier: input.tier, reason: null };
}
