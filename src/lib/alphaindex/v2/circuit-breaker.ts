/**
 * v2 — drawdown circuit breaker (Fix 5).
 *
 * Hard mechanical rules. No discretion, no human override at the
 * allocator level — the breaker fires whenever the threshold is met.
 *
 *   DD ≤ -8%   →  HALVED   (satellite weights × 0.5)
 *   DD ≤ -12%  →  ZEROED   (all satellites → 0)
 *   Recovery to within -4% of peak →  exit breaker
 *
 * The BTC anchor is NEVER cut by the breaker. Selling the market beta
 * at the bottom of a -12% drawdown is precisely the wrong move; the
 * breaker pulls only the alpha bets while the anchor rides the cycle.
 *
 * v1's stress tests showed -50% drawdowns. This rule mechanically
 * prevents that — at -12% the satellite book is fully de-risked to
 * cash, and the floor of further loss becomes BTC's own drawdown.
 *
 * Companion tests: tests/alphaindex-v2/circuit-breaker.test.ts.
 */

export const HALVED_THRESHOLD = -0.08; // -8%
export const ZEROED_THRESHOLD = -0.12; // -12%
export const EXIT_RECOVERY = -0.04; // exit when DD shallower than -4%

export type BreakerStatus = "normal" | "halved" | "zeroed";

export interface BreakerInputs {
  current_nav: number;
  peak_nav: number;
  weights: Record<string, number>;
  btc_anchor_id: string;
}

export interface BreakerResult {
  state: BreakerStatus;
  /** Drawdown in percent (negative number, e.g. -8.5). */
  drawdown_pct: number;
  /** Adjusted weights with satellite multiplier applied. */
  weights: Record<string, number>;
  /** Notional (in fraction-of-NAV terms) freed to cash. */
  freed_to_cash: number;
}

/** Compute drawdown from peak as a fraction (e.g. -0.085 = -8.5%). */
function drawdown(current: number, peak: number): number {
  if (peak <= 0) return 0;
  return Math.min(0, (current - peak) / peak);
}

/**
 * Apply breaker. Pure function — deterministic on inputs. The caller
 * is responsible for tracking peak_nav across rebalances and for
 * gating re-entry via `shouldExitBreaker`.
 */
export function applyCircuitBreaker(input: BreakerInputs): BreakerResult {
  const dd = drawdown(input.current_nav, input.peak_nav);
  const ddPct = dd * 100;

  let state: BreakerStatus = "normal";
  let multiplier = 1.0;
  if (dd <= ZEROED_THRESHOLD) {
    state = "zeroed";
    multiplier = 0;
  } else if (dd <= HALVED_THRESHOLD) {
    state = "halved";
    multiplier = 0.5;
  }

  const out: Record<string, number> = {};
  let freed = 0;
  for (const [a, w] of Object.entries(input.weights)) {
    if (a === input.btc_anchor_id) {
      out[a] = w; // anchor never cut
      continue;
    }
    const newW = w * multiplier;
    out[a] = newW;
    freed += w - newW;
  }

  return {
    state,
    drawdown_pct: Math.round(ddPct * 100) / 100,
    weights: out,
    freed_to_cash: freed,
  };
}

/**
 * Should the caller exit the breaker and resume normal allocation?
 * True when drawdown has recovered to shallower than EXIT_RECOVERY.
 */
export function shouldExitBreaker(
  state: BreakerStatus,
  drawdown_pct: number,
): boolean {
  if (state === "normal") return false;
  // drawdown_pct is in PERCENT (e.g. -3.99 means -3.99%).
  return drawdown_pct / 100 > EXIT_RECOVERY;
}
