/**
 * Part 2 regression — multi-benchmark comparison.
 *
 * Two new benchmarks to compare against AlphaCore + BTC:
 *   - Naive momentum: equal-weighted top-7 by 30d momentum, weekly rebal
 *   - Hybrid simple: 70/30 BTC + equal-weighted momentum equities
 *
 * Both run zero-news; the test verifies the benchmark math, not the
 * production strategy. Plus: the cache must prevent recomputation for
 * identical inputs.
 */

import { describe, expect, it } from "vitest";
import {
  buildBenchmarkSpec,
  computeBenchmarkSeries,
  benchmarkCacheStats,
  _clearBenchmarkCache,
  type DailyBar,
} from "@/lib/alphaindex/benchmarks";

const DAY = 24 * 3600 * 1000;
const D0 = Date.UTC(2026, 0, 1);

function bars(asset_id: string, closes: number[]): DailyBar[] {
  return closes.map((c, i) => ({
    asset_id,
    date: new Date(D0 + i * DAY).toISOString().slice(0, 10),
    ts_ms: D0 + i * DAY,
    open: c,
    high: c * 1.005,
    low: c * 0.995,
    close: c,
  }));
}

function ramp(from: number, to: number, n: number): number[] {
  if (n < 2) return [from];
  const step = (to - from) / (n - 1);
  return Array.from({ length: n }, (_, i) => from + i * step);
}

describe("Part 2 — naive momentum benchmark", () => {
  it("picks the top-7 assets by 30d momentum and equal-weights them", () => {
    // 8 assets, all with 60-day series. Different end-of-window momenta.
    const series = new Map<string, DailyBar[]>([
      ["A", bars("A", ramp(100, 130, 60))], // +30%
      ["B", bars("B", ramp(100, 125, 60))], // +25%
      ["C", bars("C", ramp(100, 120, 60))], // +20%
      ["D", bars("D", ramp(100, 115, 60))], // +15%
      ["E", bars("E", ramp(100, 110, 60))], // +10%
      ["F", bars("F", ramp(100, 105, 60))], // +5%
      ["G", bars("G", ramp(100, 100, 60))], // 0%
      ["H", bars("H", ramp(100, 90, 60))],  // -10%
    ]);

    const spec = buildBenchmarkSpec("naive_momentum_top7");
    const r = computeBenchmarkSeries({
      spec,
      start_ms: D0,
      end_ms: D0 + 59 * DAY,
      series,
      starting_nav: 10_000,
    });
    // Last rebalance picked top 7 by 30d return. H (-10%) should be excluded.
    const lastWeights = r.weight_history[r.weight_history.length - 1].weights;
    expect(lastWeights.has("H")).toBe(false);
    // The 7 included should each be at 1/7 ≈ 0.143.
    for (const [asset, w] of lastWeights.entries()) {
      expect(w).toBeCloseTo(1 / 7, 2);
      expect(asset).not.toBe("H");
    }
    // Weights sum to 1.
    const total = [...lastWeights.values()].reduce((s, x) => s + x, 0);
    expect(total).toBeCloseTo(1.0, 5);
  });

  it("rebalances weekly (interval = 7 days)", () => {
    const series = new Map<string, DailyBar[]>([
      ["A", bars("A", Array(60).fill(100))],
      ["B", bars("B", Array(60).fill(100))],
    ]);
    const spec = buildBenchmarkSpec("naive_momentum_top7");
    const r = computeBenchmarkSeries({
      spec,
      start_ms: D0,
      end_ms: D0 + 59 * DAY,
      series,
      starting_nav: 10_000,
    });
    // 60 days, weekly cadence → 9 rebalances (incl. day 0).
    expect(r.weight_history.length).toBeGreaterThanOrEqual(8);
    expect(r.weight_history.length).toBeLessThanOrEqual(10);
  });
});

describe("Part 2 — hybrid simple benchmark (70 BTC / 30 equities)", () => {
  it("maintains a 70/30 BTC/equities split at every rebalance", () => {
    const series = new Map<string, DailyBar[]>([
      ["tok-btc", bars("tok-btc", ramp(100, 110, 60))],
      // The hybrid spec uses these 4 equity tickers; the test keeps them
      // equal-weighted within the 30% sleeve → 7.5% each.
      ["stk-intc", bars("stk-intc", ramp(100, 110, 60))],
      ["stk-amd", bars("stk-amd", ramp(100, 110, 60))],
      ["stk-mu", bars("stk-mu", ramp(100, 110, 60))],
      ["stk-orcl", bars("stk-orcl", ramp(100, 110, 60))],
    ]);
    const spec = buildBenchmarkSpec("hybrid_simple");
    const r = computeBenchmarkSeries({
      spec,
      start_ms: D0,
      end_ms: D0 + 59 * DAY,
      series,
      starting_nav: 10_000,
    });

    for (const snap of r.weight_history) {
      const btc = snap.weights.get("tok-btc") ?? 0;
      const equitySleeve = ["stk-intc", "stk-amd", "stk-mu", "stk-orcl"]
        .map((a) => snap.weights.get(a) ?? 0)
        .reduce((s, x) => s + x, 0);
      // Allow small numerical drift; we re-normalize on each rebalance.
      expect(btc).toBeCloseTo(0.7, 1);
      expect(equitySleeve).toBeCloseTo(0.3, 1);
      // Each equity gets 1/4 of the 30% sleeve = 7.5%.
      for (const asset of ["stk-intc", "stk-amd", "stk-mu", "stk-orcl"]) {
        const w = snap.weights.get(asset);
        if (w != null) expect(w).toBeCloseTo(0.075, 2);
      }
    }
  });

  it("hybrid: NAV trajectory matches a constant 70/30 mix when prices move uniformly", () => {
    // All assets ramp +10% identically → portfolio NAV up exactly 10%.
    const closes = ramp(100, 110, 60);
    const series = new Map<string, DailyBar[]>([
      ["tok-btc", bars("tok-btc", closes)],
      ["stk-intc", bars("stk-intc", closes)],
      ["stk-amd", bars("stk-amd", closes)],
      ["stk-mu", bars("stk-mu", closes)],
      ["stk-orcl", bars("stk-orcl", closes)],
    ]);
    const spec = buildBenchmarkSpec("hybrid_simple");
    const r = computeBenchmarkSeries({
      spec,
      start_ms: D0,
      end_ms: D0 + 59 * DAY,
      series,
      starting_nav: 10_000,
    });
    const finalNav = r.daily_nav[r.daily_nav.length - 1].nav_usd;
    expect(finalNav).toBeCloseTo(11_000, -2); // +10% within rounding noise
  });
});

describe("Part 2 — cache prevents recomputation", () => {
  it("identical (spec, range, series) returns the cached series — no recompute", () => {
    _clearBenchmarkCache();
    const series = new Map<string, DailyBar[]>([
      ["tok-btc", bars("tok-btc", ramp(100, 110, 60))],
      ["stk-intc", bars("stk-intc", ramp(100, 110, 60))],
      ["stk-amd", bars("stk-amd", ramp(100, 110, 60))],
      ["stk-mu", bars("stk-mu", ramp(100, 110, 60))],
      ["stk-orcl", bars("stk-orcl", ramp(100, 110, 60))],
    ]);
    const spec = buildBenchmarkSpec("hybrid_simple");
    const inputs = {
      spec,
      start_ms: D0,
      end_ms: D0 + 59 * DAY,
      series,
      starting_nav: 10_000,
    };
    computeBenchmarkSeries(inputs);
    const before = benchmarkCacheStats();
    expect(before.hits).toBe(0);
    expect(before.misses).toBe(1);
    computeBenchmarkSeries(inputs);
    const after = benchmarkCacheStats();
    expect(after.hits).toBe(1);
    expect(after.misses).toBe(1);
  });

  it("different specs miss the cache and recompute", () => {
    _clearBenchmarkCache();
    const series = new Map<string, DailyBar[]>([
      ["tok-btc", bars("tok-btc", ramp(100, 110, 30))],
      ["A", bars("A", ramp(100, 105, 30))],
      ["B", bars("B", ramp(100, 105, 30))],
      ["C", bars("C", ramp(100, 105, 30))],
      ["D", bars("D", ramp(100, 105, 30))],
      ["E", bars("E", ramp(100, 105, 30))],
      ["F", bars("F", ramp(100, 105, 30))],
      ["G", bars("G", ramp(100, 105, 30))],
    ]);
    computeBenchmarkSeries({
      spec: buildBenchmarkSpec("naive_momentum_top7"),
      start_ms: D0,
      end_ms: D0 + 29 * DAY,
      series,
      starting_nav: 10_000,
    });
    computeBenchmarkSeries({
      spec: buildBenchmarkSpec("hybrid_simple"),
      start_ms: D0,
      end_ms: D0 + 29 * DAY,
      series,
      starting_nav: 10_000,
    });
    const stats = benchmarkCacheStats();
    expect(stats.misses).toBe(2);
    expect(stats.hits).toBe(0);
  });
});
