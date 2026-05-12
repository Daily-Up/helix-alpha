/**
 * v2 — portfolio volatility targeting (Fix 2).
 *
 * The single most important risk control. Continuously rescales all
 * non-cash positions so the portfolio's realized volatility tracks a
 * fixed target (40% annualized — slightly above BTC's typical
 * realized vol). Triggers:
 *
 *   realized_vol > 1.2 × target  →  scale DOWN (cash grows)
 *   realized_vol < 0.8 × target  →  scale UP   (cash shrinks)
 *
 * Scaling is uniform — every non-cash position is multiplied by the
 * same factor — so relative weights are preserved. Only the
 * cash/notional ratio changes.
 *
 * Why uniform scaling: the allocator's regime + signal logic produces
 * the relative weights. Vol-targeting layers on top to control
 * notional exposure without second-guessing the picks.
 *
 * Companion tests: tests/alphaindex-v2/vol-targeting.test.ts.
 */

export const TARGET_VOL = 0.40; // 40% annualized
export const SCALE_DOWN_RATIO = 1.20; // trigger at 1.2× target
export const SCALE_UP_RATIO = 0.80; // trigger at 0.8× target (default)
/** v2.1: TREND-only scale-up trigger. Re-engages risk faster when
 *  vol drops below target during a confirmed uptrend. The asymmetry
 *  fixes v2's "stayed defensive after vol spike" failure mode. */
export const SCALE_UP_RATIO_TREND = 1.00;

export interface VolTargetInputs {
  /** Pre-scaling weights, asset_id → fraction. Should sum with cash to ≤1. */
  weights: Record<string, number>;
  cash_weight: number;
  /** Annualized realized vol of the *portfolio* (not BTC). */
  realized_vol: number;
  /** When "TREND", scale-up triggers earlier (ratio < 1.0× vs 0.8×).
   *  Default behavior matches the original v2 thresholds. */
  regime?: "TREND" | "CHOP" | "DRAWDOWN";
}

export interface VolTargetResult {
  scaled_weights: Record<string, number>;
  scaled_cash: number;
  scale_factor: number;
  trigger: "scale_up" | "scale_down" | null;
}

/**
 * Apply vol-targeting. Pure function: deterministic on identical
 * inputs. Edge cases:
 *   - realized_vol ≤ 0 → no-op (we have no signal to act on)
 *   - cash_weight = 0 with scale-up → bounded by full deployment
 */
export function applyVolTarget(input: VolTargetInputs): VolTargetResult {
  if (input.realized_vol <= 0) {
    return passthrough(input);
  }
  const ratio = input.realized_vol / TARGET_VOL;
  let scale = 1.0;
  let trigger: VolTargetResult["trigger"] = null;

  // v2.1 asymmetric scale-up: TREND regime engages earlier (1.0× vs 0.8×).
  const scaleUpRatio =
    input.regime === "TREND" ? SCALE_UP_RATIO_TREND : SCALE_UP_RATIO;

  if (ratio > SCALE_DOWN_RATIO) {
    scale = TARGET_VOL / input.realized_vol;
    trigger = "scale_down";
  } else if (ratio < scaleUpRatio) {
    // Up-scale to target, but capped so total ≤ 100% (cash floor 0).
    const sumNotional = Object.values(input.weights).reduce((s, x) => s + x, 0);
    const fullDeployment = sumNotional > 0 ? 1 / sumNotional : 1;
    scale = Math.min(TARGET_VOL / input.realized_vol, fullDeployment);
    trigger = scale > 1.0 ? "scale_up" : null;
  }

  const scaled: Record<string, number> = {};
  for (const [k, v] of Object.entries(input.weights)) {
    scaled[k] = v * scale;
  }
  const sumScaled = Object.values(scaled).reduce((s, x) => s + x, 0);
  const scaledCash = Math.max(0, 1 - sumScaled);

  return {
    scaled_weights: scaled,
    scaled_cash: scaledCash,
    scale_factor: scale,
    trigger,
  };
}

function passthrough(input: VolTargetInputs): VolTargetResult {
  return {
    scaled_weights: { ...input.weights },
    scaled_cash: input.cash_weight,
    scale_factor: 1.0,
    trigger: null,
  };
}

/**
 * Annualized realized vol from a daily-close series. Same formula
 * used in the existing engine — log returns × sqrt(365).
 */
export function computeRealizedVol(closes: number[]): number {
  if (closes.length < 2) return 0;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) {
      rets.push(Math.log(closes[i] / closes[i - 1]));
    }
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance =
    rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * Math.sqrt(365);
}
