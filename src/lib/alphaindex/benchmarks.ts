/**
 * Multi-benchmark series — Part 2.
 *
 * Computes daily NAV for simple alternative strategies that we compare
 * AlphaCore against on the equity-curve panel. Two specs:
 *
 *   - `naive_momentum_top7`: equal-weighted top-7 by 30d momentum,
 *     weekly rebalance, no signals
 *   - `hybrid_simple`: 70% BTC + 30% equal-weighted across a fixed
 *     equity sleeve (INTC/AMD/MU/ORCL), weekly rebalance
 *
 * Why bother: beating BTC during a bull tape is easy if you're long
 * momentum equities. The real test is whether the news-signal layer
 * adds anything over these dumb strategies. Compute these once per
 * (spec, range, series) — cache by hashed input so dashboard
 * re-renders don't recompute.
 *
 * Companion tests: tests/alphaindex-benchmarks.test.ts.
 */

import type { DailyBar } from "./backtest";
export type { DailyBar };

// ─────────────────────────────────────────────────────────────────────────
// Specs
// ─────────────────────────────────────────────────────────────────────────

export type BenchmarkName = "naive_momentum_top7" | "hybrid_simple";

export interface BenchmarkSpec {
  name: BenchmarkName;
  /** Returns weights for the given timestamp's universe state. */
  allocate: (
    asof_ms: number,
    series: Map<string, DailyBar[]>,
  ) => Map<string, number>;
  rebalance_freq_days: number;
}

/** Look up close on/before ts. */
function priceAtOrBefore(bars: DailyBar[], ts_ms: number): number | null {
  let last: number | null = null;
  for (const b of bars) {
    if (b.ts_ms <= ts_ms) last = b.close;
    else break;
  }
  return last && last > 0 ? last : null;
}

/** 30-day return computed against the day-of-or-before kline 30d earlier. */
function ret30d(bars: DailyBar[], asof_ms: number): number | null {
  const today = priceAtOrBefore(bars, asof_ms);
  const earlier = priceAtOrBefore(bars, asof_ms - 30 * 24 * 3600 * 1000);
  if (today == null || earlier == null || earlier <= 0) return null;
  return (today - earlier) / earlier;
}

/** Top N assets by 30d return. Drops assets with no momentum data. */
function topByMomentum(
  series: Map<string, DailyBar[]>,
  asof_ms: number,
  n: number,
): string[] {
  const scored: Array<{ asset_id: string; ret: number }> = [];
  for (const [asset_id, bars] of series.entries()) {
    const r = ret30d(bars, asof_ms);
    if (r != null) scored.push({ asset_id, ret: r });
  }
  scored.sort((a, b) => b.ret - a.ret);
  return scored.slice(0, n).map((x) => x.asset_id);
}

const HYBRID_EQUITIES = ["stk-intc", "stk-amd", "stk-mu", "stk-orcl"];

/**
 * Build the spec object for a benchmark name. Pure — same name returns
 * a structurally-identical spec, so cache keys are stable.
 */
export function buildBenchmarkSpec(name: BenchmarkName): BenchmarkSpec {
  switch (name) {
    case "naive_momentum_top7":
      return {
        name,
        rebalance_freq_days: 7,
        allocate: (asof_ms, series) => {
          const top = topByMomentum(series, asof_ms, 7);
          const out = new Map<string, number>();
          if (top.length === 0) return out;
          const w = 1 / top.length;
          for (const a of top) out.set(a, w);
          return out;
        },
      };
    case "hybrid_simple":
      return {
        name,
        rebalance_freq_days: 7,
        allocate: (_asof, series) => {
          const out = new Map<string, number>();
          // 70% BTC if priceable today; otherwise skip.
          const btc = series.get("tok-btc");
          if (btc) out.set("tok-btc", 0.7);
          // 30% sleeve, equal-weighted across the equities that have data.
          const present = HYBRID_EQUITIES.filter((a) => {
            const b = series.get(a);
            return b && b.length > 0;
          });
          if (present.length > 0) {
            const eachW = 0.3 / present.length;
            for (const a of present) out.set(a, eachW);
          }
          // Re-normalize when partial coverage means weights don't sum to 1.
          const total = [...out.values()].reduce((s, x) => s + x, 0);
          if (total > 0 && Math.abs(total - 1) > 1e-9) {
            for (const [k, v] of out.entries()) out.set(k, v / total);
          }
          return out;
        },
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Compute series
// ─────────────────────────────────────────────────────────────────────────

export interface BenchmarkComputeInput {
  spec: BenchmarkSpec;
  start_ms: number;
  end_ms: number;
  series: Map<string, DailyBar[]>;
  starting_nav: number;
}

export interface BenchmarkResult {
  daily_nav: Array<{ ts_ms: number; nav_usd: number }>;
  weight_history: Array<{ ts_ms: number; weights: Map<string, number> }>;
  return_pct: number;
  max_drawdown_pct: number;
  sharpe: number | null;
}

const cache = new Map<string, BenchmarkResult>();
let cacheHits = 0;
let cacheMisses = 0;

/** Quickly hash a series Map by asset_id and bar count (avoids deep-eq). */
function hashSeries(series: Map<string, DailyBar[]>): string {
  const ids = [...series.keys()].sort();
  return ids
    .map((id) => `${id}:${series.get(id)!.length}:${series.get(id)![0]?.ts_ms ?? 0}`)
    .join("|");
}

function cacheKey(input: BenchmarkComputeInput): string {
  return [
    input.spec.name,
    input.start_ms,
    input.end_ms,
    input.starting_nav,
    hashSeries(input.series),
  ].join("#");
}

export function computeBenchmarkSeries(
  input: BenchmarkComputeInput,
): BenchmarkResult {
  const key = cacheKey(input);
  const hit = cache.get(key);
  if (hit) {
    cacheHits++;
    return hit;
  }
  cacheMisses++;

  const dayMs = 24 * 3600 * 1000;
  const days = Math.floor((input.end_ms - input.start_ms) / dayMs) + 1;
  const dailyNav: BenchmarkResult["daily_nav"] = [];
  const weightHistory: BenchmarkResult["weight_history"] = [];
  let nav = input.starting_nav;
  let quantities = new Map<string, number>();

  for (let d = 0; d < days; d++) {
    const ts = input.start_ms + d * dayMs;
    const isRebalance = d === 0 || d % input.spec.rebalance_freq_days === 0;

    // Mark-to-market FIRST so rebalances use today's portfolio value as
    // the basis. Otherwise reallocating with yesterday's nav at today's
    // prices "freezes" value across the rebalance day.
    let mtm = 0;
    for (const [asset_id, qty] of quantities.entries()) {
      const bars = input.series.get(asset_id);
      if (!bars) continue;
      const px = priceAtOrBefore(bars, ts);
      if (px == null) continue;
      mtm += qty * px;
    }
    if (mtm > 0) nav = mtm;

    if (isRebalance) {
      const targetWeights = input.spec.allocate(ts, input.series);
      const newQuantities = new Map<string, number>();
      for (const [asset_id, w] of targetWeights.entries()) {
        const bars = input.series.get(asset_id);
        if (!bars) continue;
        const px = priceAtOrBefore(bars, ts);
        if (px == null) continue;
        newQuantities.set(asset_id, (nav * w) / px);
      }
      quantities = newQuantities;
      weightHistory.push({ ts_ms: ts, weights: targetWeights });
    }

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

  const result: BenchmarkResult = {
    daily_nav: dailyNav,
    weight_history: weightHistory,
    return_pct: Math.round(returnPct * 10) / 10,
    max_drawdown_pct: Math.round(maxDD * 1000) / 10,
    sharpe: sharpe != null ? Math.round(sharpe * 100) / 100 : null,
  };
  cache.set(key, result);
  return result;
}

export function benchmarkCacheStats(): { hits: number; misses: number; size: number } {
  return { hits: cacheHits, misses: cacheMisses, size: cache.size };
}

export function _clearBenchmarkCache(): void {
  cache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}
