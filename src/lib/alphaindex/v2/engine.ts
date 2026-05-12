/**
 * v2 — engine. Composes regime detection → allocator → signal boosts
 * → vol-targeting → circuit breaker into one entry point that can be
 * driven from both live rebalances and the historical-replay harness.
 *
 * Invariants enforced here (cross-check against I-32/33/34):
 *   - BTC anchor stays in [BTC_MIN, BTC_MAX] across all stages
 *   - No single satellite > MAX_SINGLE_SATELLITE
 *   - News signals move any single weight by ≤ MAX_SIGNAL_BOOST
 *   - When DD ≤ -12%, satellites all zeroed (circuit breaker)
 *
 * The interface accepts a `series` map (asset_id → daily bars) and a
 * timestamp; this matches the existing backtest/replay infrastructure
 * so the same harness can drive v1 and v2 side-by-side.
 */

import type { DailyBar } from "../backtest";
import {
  classifyRawRegime,
  applyRegimeSmoothing,
  newRegimeState,
  type Regime,
  type RegimeState,
} from "./regime";
import {
  allocateV2,
  BTC_MIN,
  BTC_MAX,
  MAX_SINGLE_SATELLITE,
  MAX_SINGLE_SATELLITE_TREND,
  type SatelliteCandidate,
} from "./allocator";
import {
  applySignalBoosts,
  type SignalEntry,
} from "./signal-integration";
import {
  applyVolTarget,
  computeRealizedVol,
} from "./vol-targeting";
import {
  applyCircuitBreaker,
  shouldExitBreaker,
  type BreakerStatus,
} from "./circuit-breaker";

const BTC_ID = "tok-btc";
const DAY_MS = 24 * 3600 * 1000;

// ─────────────────────────────────────────────────────────────────────────
// Cluster taxonomy (Fix 4)
//
// Hard-coded mapping from asset_id prefix to cluster. This is good
// enough for the build-a-thon and means every test of v2 has a stable
// cluster assignment. A production system would persist this on the
// asset row.
// ─────────────────────────────────────────────────────────────────────────

function clusterOf(asset_id: string): string {
  if (asset_id.startsWith("rwa-")) return "RWA";
  if (asset_id === BTC_ID) return "BTC";
  if (asset_id === "tok-eth" || asset_id === "tok-sol" || asset_id === "tok-bnb")
    return "L1";
  if (asset_id.startsWith("idx-")) return "index";
  if (asset_id.startsWith("stk-")) return "equities";
  if (
    asset_id === "tok-doge" ||
    asset_id === "tok-shib" ||
    asset_id === "tok-pepe" ||
    asset_id === "tok-trump" ||
    asset_id === "tok-floki" ||
    asset_id === "tok-bonk"
  )
    return "memes";
  if (asset_id.startsWith("tok-")) return "alt";
  return "other";
}

function isDefensive(asset_id: string): boolean {
  // RWA + gold are the "defensives" eligible during DRAWDOWN regime.
  return asset_id.startsWith("rwa-") || asset_id === "rwa-xaut";
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers — price lookup
// ─────────────────────────────────────────────────────────────────────────

function priceAtOrBefore(bars: DailyBar[], ts_ms: number): number | null {
  let last: number | null = null;
  for (const b of bars) {
    if (b.ts_ms <= ts_ms) last = b.close;
    else break;
  }
  return last && last > 0 ? last : null;
}

function ret30d(bars: DailyBar[], ts_ms: number): number | null {
  const today = priceAtOrBefore(bars, ts_ms);
  const earlier = priceAtOrBefore(bars, ts_ms - 30 * DAY_MS);
  if (today == null || earlier == null || earlier <= 0) return null;
  return (today - earlier) / earlier;
}

function btcCloses30d(series: Map<string, DailyBar[]>, ts_ms: number): number[] {
  const bars = series.get(BTC_ID);
  if (!bars) return [];
  return bars
    .filter((b) => b.ts_ms <= ts_ms && b.ts_ms > ts_ms - 30 * DAY_MS)
    .map((b) => b.close)
    .filter((x) => x > 0);
}

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

export interface V2EngineState {
  regime: RegimeState;
  /** Peak NAV ever observed; drives the circuit breaker. */
  peak_nav: number;
  /** Current breaker state — sticky across days until recovery. */
  breaker: BreakerStatus;
  /** Last NAV used as the realized-vol input for vol-targeting. */
  last_nav_history: number[];
}

export function newEngineState(): V2EngineState {
  return {
    regime: newRegimeState("CHOP"),
    peak_nav: 0,
    breaker: "normal",
    last_nav_history: [],
  };
}

export interface V2EngineInputs {
  asof_ms: number;
  series: Map<string, DailyBar[]>;
  current_nav: number;
  /** Optional signed score per asset; empty in zero-news mode. */
  signals?: SignalEntry[];
  state: V2EngineState;
}

export interface V2EngineResult {
  weights: Record<string, number>;
  cash_weight: number;
  next_state: V2EngineState;
  meta: {
    regime: Regime;
    vol_scale: number;
    vol_trigger: "scale_up" | "scale_down" | null;
    breaker: BreakerStatus;
    drawdown_pct: number;
    queued_signals: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Engine
// ─────────────────────────────────────────────────────────────────────────

export function runV2Engine(input: V2EngineInputs): V2EngineResult {
  const { asof_ms, series, current_nav, state } = input;

  // ── 1. Update regime state from BTC's last 30d closes
  const btcCloses = btcCloses30d(series, asof_ms);
  const rawRegime = classifyRawRegime(btcCloses);
  const regimeState = applyRegimeSmoothing(state.regime, rawRegime);

  // ── 2. Build satellite candidates from the rest of the series
  const candidates: SatelliteCandidate[] = [];
  for (const [asset_id, bars] of series.entries()) {
    if (asset_id === BTC_ID) continue;
    const r = ret30d(bars, asof_ms);
    if (r == null) continue;
    candidates.push({
      asset_id,
      ret30d: r,
      cluster: clusterOf(asset_id),
      is_defensive: isDefensive(asset_id),
    });
  }

  // ── 3. Allocator — base weights from regime
  const allocated = allocateV2({
    regime: regimeState.current,
    satellites: candidates,
    btc_anchor_id: BTC_ID,
  });

  // ── 4. Apply bounded signal boosts
  const boosted = applySignalBoosts({
    base_weights: allocated.weights,
    base_cash: allocated.cash_weight,
    signals: input.signals ?? [],
    regime: regimeState.current,
    btc_anchor_id: BTC_ID,
  });

  // ── 5. Vol-targeting — scale notional based on portfolio realized vol
  // We approximate portfolio vol with BTC's vol (good enough since the
  // anchor dominates the book). When NAV history exists we'd switch to
  // it but for the first rebalances BTC is the cleanest proxy.
  const realizedVol =
    state.last_nav_history.length >= 5
      ? computeRealizedVol(state.last_nav_history)
      : computeRealizedVol(btcCloses);

  const volScaled = applyVolTarget({
    weights: boosted.weights,
    cash_weight: boosted.cash_weight,
    realized_vol: realizedVol,
    regime: regimeState.current,
  });

  // BTC anchor was in [BTC_MIN, BTC_MAX] before vol-targeting; scaling
  // can push it below BTC_MIN. Re-clamp and let the rest renormalize.
  const clamped: Record<string, number> = { ...volScaled.scaled_weights };
  if (clamped[BTC_ID] != null) {
    const target = Math.min(Math.max(clamped[BTC_ID], BTC_MIN), BTC_MAX);
    clamped[BTC_ID] = target;
  }
  // Ensure no satellite exceeded the regime's per-asset cap after a
  // vol scale-up (scale-down can never push a weight above its prior cap).
  // v2.1: TREND uses the relaxed 10% cap; CHOP/DRAWDOWN keep 8%.
  const regimeMaxSingle =
    regimeState.current === "TREND"
      ? MAX_SINGLE_SATELLITE_TREND
      : MAX_SINGLE_SATELLITE;
  for (const k of Object.keys(clamped)) {
    if (k === BTC_ID) continue;
    if (clamped[k] > regimeMaxSingle) clamped[k] = regimeMaxSingle;
  }
  let sumClamped = Object.values(clamped).reduce((s, x) => s + x, 0);
  let cashAfterVol = Math.max(0, 1 - sumClamped);

  // ── 6. Circuit breaker — last-stage hard cut
  const breakerInputs = applyCircuitBreaker({
    current_nav,
    peak_nav: Math.max(state.peak_nav, current_nav),
    weights: clamped,
    btc_anchor_id: BTC_ID,
  });

  // Sticky breaker: once HALVED/ZEROED, stay there until we recover.
  let nextBreaker: BreakerStatus = breakerInputs.state;
  if (
    state.breaker !== "normal" &&
    !shouldExitBreaker(state.breaker, breakerInputs.drawdown_pct)
  ) {
    // Carry forward the prior (worse) state if we haven't recovered.
    const order: BreakerStatus[] = ["normal", "halved", "zeroed"];
    if (order.indexOf(state.breaker) > order.indexOf(nextBreaker)) {
      nextBreaker = state.breaker;
    }
  }

  // Re-apply the worst-of breaker cut if state was downgraded.
  let finalWeights = breakerInputs.weights;
  if (nextBreaker !== breakerInputs.state) {
    const mult = nextBreaker === "zeroed" ? 0 : nextBreaker === "halved" ? 0.5 : 1;
    finalWeights = {};
    for (const [k, w] of Object.entries(clamped)) {
      finalWeights[k] = k === BTC_ID ? w : w * mult;
    }
  }

  const finalSum = Object.values(finalWeights).reduce((s, x) => s + x, 0);
  const finalCash = Math.max(0, 1 - finalSum);

  // ── 7. Build next state
  const nextNavHistory = [...state.last_nav_history, current_nav].slice(-30);
  const nextState: V2EngineState = {
    regime: regimeState,
    peak_nav: Math.max(state.peak_nav, current_nav),
    breaker: nextBreaker,
    last_nav_history: nextNavHistory,
  };

  return {
    weights: finalWeights,
    cash_weight: finalCash,
    next_state: nextState,
    meta: {
      regime: regimeState.current,
      vol_scale: volScaled.scale_factor,
      vol_trigger: volScaled.trigger,
      breaker: nextBreaker,
      drawdown_pct: breakerInputs.drawdown_pct,
      queued_signals: boosted.queued_signals.length,
    },
  };
}
