/**
 * v2 — regime detection (Fix 3).
 *
 * Classifies BTC's recent price action into one of three regimes:
 *   TREND     — momentum positive, volatility moderate. Risk-on.
 *   CHOP      — flat market, low momentum, low vol.
 *   DRAWDOWN  — material peak-to-current decline OR volatility spike.
 *
 * Transitions are smoothed: a regime switch requires 3 consecutive days
 * observing the new regime. This prevents the allocator from flipping
 * back and forth during noisy stretches.
 *
 * Why these thresholds:
 *   - +5% 30d momentum is "more than noise but not euphoric"
 *   - -10% peak-to-current is roughly 1.5× a typical pullback in BTC
 *   - 80% annualized realized vol is the historical 75th percentile
 *
 * Companion tests: tests/alphaindex-v2/regime.test.ts.
 */

export type Regime = "TREND" | "CHOP" | "DRAWDOWN";

const MOMENTUM_TREND_THRESHOLD = 0.05; // +5%
const DRAWDOWN_THRESHOLD = -0.10; // -10% from rolling peak
const VOL_HIGH_ANNUALIZED = 0.80; // 80% — DRAWDOWN trigger
const SMOOTHING_DAYS = 3;
/** v2.1: when exiting DRAWDOWN to TREND specifically, require only
 *  1 day of confirmation (vs 3 for all other transitions). Hysteresis
 *  is correct for entering caution; symmetric hysteresis is wrong for
 *  exiting it — we stayed defensive too long after vol spikes in v2. */
const SMOOTHING_DAYS_DRAWDOWN_TO_TREND = 1;

/**
 * Classify the regime from the most recent ≤30 close prices. Older
 * data outside the window is irrelevant — regime is short-lookback.
 *
 * Pure function; deterministic on identical inputs.
 */
export function classifyRawRegime(closes30d: number[]): Regime {
  // Insufficient data → conservative default. CHOP keeps risk middling
  // until enough history exists to make a real call.
  if (closes30d.length < 5) return "CHOP";

  const last = closes30d[closes30d.length - 1];
  const first = closes30d[0];
  const peak = closes30d.reduce((m, x) => (x > m ? x : m), -Infinity);

  if (last <= 0 || first <= 0) return "CHOP";

  const momentum = (last - first) / first;
  const ddFromPeak = peak > 0 ? (last - peak) / peak : 0;

  // Realized vol from daily log returns
  let logRets: number[] = [];
  for (let i = 1; i < closes30d.length; i++) {
    if (closes30d[i - 1] > 0 && closes30d[i] > 0) {
      logRets.push(Math.log(closes30d[i] / closes30d[i - 1]));
    }
  }
  let annVol = 0;
  if (logRets.length >= 2) {
    const mean = logRets.reduce((s, x) => s + x, 0) / logRets.length;
    const variance =
      logRets.reduce((s, x) => s + (x - mean) ** 2, 0) / logRets.length;
    annVol = Math.sqrt(variance) * Math.sqrt(365);
  }

  if (ddFromPeak <= DRAWDOWN_THRESHOLD || annVol > VOL_HIGH_ANNUALIZED) {
    return "DRAWDOWN";
  }
  if (momentum > MOMENTUM_TREND_THRESHOLD && annVol <= VOL_HIGH_ANNUALIZED) {
    return "TREND";
  }
  return "CHOP";
}

// ─────────────────────────────────────────────────────────────────────────
// Smoothed regime state — 3-consecutive-day confirmation
// ─────────────────────────────────────────────────────────────────────────

export interface RegimeState {
  current: Regime;
  /** How long the current regime has held (in update ticks). */
  days_in_current: number;
  /** Candidate regime that is "auditioning" to replace current. */
  pending: Regime | null;
  /** Consecutive days the pending regime has been observed. */
  pending_streak: number;
}

export function newRegimeState(initial: Regime = "CHOP"): RegimeState {
  return { current: initial, days_in_current: 0, pending: null, pending_streak: 0 };
}

/**
 * Update the smoothed state given today's raw classification. Switches
 * only after `SMOOTHING_DAYS` consecutive observations of a new regime.
 */
export function applyRegimeSmoothing(
  prev: RegimeState,
  raw: Regime,
): RegimeState {
  if (raw === prev.current) {
    return {
      current: prev.current,
      days_in_current: prev.days_in_current + 1,
      pending: null,
      pending_streak: 0,
    };
  }
  // raw differs from current — accumulate or reset pending
  // v2.1: asymmetric exit. DRAWDOWN→TREND needs only 1 day; everything
  // else still requires 3 days of confirmation.
  const required =
    prev.current === "DRAWDOWN" && raw === "TREND"
      ? SMOOTHING_DAYS_DRAWDOWN_TO_TREND
      : SMOOTHING_DAYS;
  const streak = prev.pending === raw ? prev.pending_streak + 1 : 1;
  if (streak >= required) {
    return {
      current: raw,
      days_in_current: 1,
      pending: null,
      pending_streak: 0,
    };
  }
  return {
    current: prev.current,
    days_in_current: prev.days_in_current + 1,
    pending: raw,
    pending_streak: streak,
  };
}
