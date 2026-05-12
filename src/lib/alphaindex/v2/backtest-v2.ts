/**
 * v2 — historical replay harness.
 *
 * Walks daily price data through the v2 engine and emits a NAV series
 * + drawdown / return / Sharpe metrics. Mirrors the v1 `backtest.ts`
 * interface so the same UI components and stress-test infrastructure
 * can drive both side-by-side.
 *
 * Signals are NOT replayed (zero-news mode, same caveat as v1
 * stress tests). Results reflect ONLY the framework — regime
 * detection, vol-targeting, anchor + concentration, circuit breaker.
 */

import type { DailyBar } from "../backtest";
import {
  newEngineState,
  runV2Engine,
  type V2EngineState,
} from "./engine";

export interface V2BacktestInput {
  start_ms: number;
  end_ms: number;
  series: Map<string, DailyBar[]>;
  starting_nav: number;
  rebalance_freq_days?: number;
}

export interface V2BacktestResult {
  daily_nav: Array<{ ts_ms: number; nav_usd: number }>;
  weight_history: Array<{ ts_ms: number; regime: string; weights: Record<string, number> }>;
  return_pct: number;
  max_drawdown_pct: number;
  sharpe: number | null;
  rebalance_count: number;
  /** Per-day regime trace for the UI band overlay. */
  regime_trace: Array<{ ts_ms: number; regime: string; breaker: string }>;
}

const DAY_MS = 24 * 3600 * 1000;

function priceAtOrBefore(bars: DailyBar[], ts_ms: number): number | null {
  let last: number | null = null;
  for (const b of bars) {
    if (b.ts_ms <= ts_ms) last = b.close;
    else break;
  }
  return last && last > 0 ? last : null;
}

export function runV2Backtest(input: V2BacktestInput): V2BacktestResult {
  const days = Math.floor((input.end_ms - input.start_ms) / DAY_MS) + 1;
  const rebalanceFreq = input.rebalance_freq_days ?? 7;

  const dailyNav: V2BacktestResult["daily_nav"] = [];
  const weightHistory: V2BacktestResult["weight_history"] = [];
  const regimeTrace: V2BacktestResult["regime_trace"] = [];
  let nav = input.starting_nav;
  let quantities = new Map<string, number>();
  let cashUsd = input.starting_nav;
  let state: V2EngineState = newEngineState();
  state.peak_nav = input.starting_nav;
  let rebalanceCount = 0;

  for (let d = 0; d < days; d++) {
    const ts = input.start_ms + d * DAY_MS;
    const isRebalance = d === 0 || d % rebalanceFreq === 0;

    // Mark-to-market BEFORE rebalance (same fix as benchmarks).
    let mtm = 0;
    for (const [a, qty] of quantities.entries()) {
      const bars = input.series.get(a);
      if (!bars) continue;
      const px = priceAtOrBefore(bars, ts);
      if (px == null) continue;
      mtm += qty * px;
    }
    nav = mtm + cashUsd;

    if (isRebalance) {
      const result = runV2Engine({
        asof_ms: ts,
        series: input.series,
        current_nav: nav,
        signals: [],
        state,
      });
      const newQuantities = new Map<string, number>();
      let consumedNotional = 0;
      for (const [asset_id, w] of Object.entries(result.weights)) {
        const bars = input.series.get(asset_id);
        if (!bars) continue;
        const px = priceAtOrBefore(bars, ts);
        if (px == null) continue;
        const usd = nav * w;
        consumedNotional += usd;
        newQuantities.set(asset_id, usd / px);
      }
      quantities = newQuantities;
      cashUsd = Math.max(0, nav - consumedNotional);
      weightHistory.push({
        ts_ms: ts,
        regime: result.meta.regime,
        weights: result.weights,
      });
      state = result.next_state;
      rebalanceCount++;
      regimeTrace.push({
        ts_ms: ts,
        regime: result.meta.regime,
        breaker: result.meta.breaker,
      });
    } else {
      // Inherit prior regime/breaker for the trace.
      const lastTrace = regimeTrace[regimeTrace.length - 1];
      regimeTrace.push({
        ts_ms: ts,
        regime: lastTrace?.regime ?? "CHOP",
        breaker: lastTrace?.breaker ?? "normal",
      });
    }

    // Re-mark-to-market post-rebalance for the day's NAV.
    let postMtm = 0;
    for (const [a, qty] of quantities.entries()) {
      const bars = input.series.get(a);
      if (!bars) continue;
      const px = priceAtOrBefore(bars, ts);
      if (px == null) continue;
      postMtm += qty * px;
    }
    nav = postMtm + cashUsd;
    dailyNav.push({ ts_ms: ts, nav_usd: nav });
  }

  // Metrics
  let returnPct = 0;
  let maxDD = 0;
  if (dailyNav.length >= 2 && dailyNav[0].nav_usd > 0) {
    returnPct =
      ((dailyNav[dailyNav.length - 1].nav_usd - dailyNav[0].nav_usd) /
        dailyNav[0].nav_usd) *
      100;
    let peak = dailyNav[0].nav_usd;
    for (const n of dailyNav) {
      if (n.nav_usd > peak) peak = n.nav_usd;
      const dd = peak > 0 ? (n.nav_usd - peak) / peak : 0;
      if (dd < maxDD) maxDD = dd;
    }
  }
  const logRets: number[] = [];
  for (let i = 1; i < dailyNav.length; i++) {
    const a = dailyNav[i - 1].nav_usd;
    const b = dailyNav[i].nav_usd;
    if (a > 0 && b > 0) logRets.push(Math.log(b / a));
  }
  let sharpe: number | null = null;
  if (logRets.length >= 2) {
    const mean = logRets.reduce((s, x) => s + x, 0) / logRets.length;
    const variance =
      logRets.reduce((s, x) => s + (x - mean) ** 2, 0) / logRets.length;
    const sd = Math.sqrt(variance);
    sharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : null;
  }

  return {
    daily_nav: dailyNav,
    weight_history: weightHistory,
    return_pct: Math.round(returnPct * 10) / 10,
    max_drawdown_pct: Math.round(maxDD * 1000) / 10,
    sharpe: sharpe != null ? Math.round(sharpe * 100) / 100 : null,
    rebalance_count: rebalanceCount,
    regime_trace: regimeTrace,
  };
}
