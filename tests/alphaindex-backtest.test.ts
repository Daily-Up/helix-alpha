/**
 * Part 1 regression — historical replay (stress testing) of the
 * AlphaIndex allocation against synthetic price histories.
 *
 * The backtest mirrors the live momentum-tilt logic but with news
 * signals = 0 (zero-news mode). It walks daily kline data, rebalances
 * weekly, and produces NAV / drawdown / Sharpe metrics so we can see
 * what the strategy looks like through drawdowns we haven't lived
 * through in production yet.
 */

import { describe, expect, it } from "vitest";
import {
  computeMomentumOnlyWeights,
  walkPriceSeries,
  computeRunMetrics,
  type DailyBar,
} from "@/lib/alphaindex/backtest";

// ────────────────────────────────────────────────────────────────────────
// Synthetic price-series helpers
// ────────────────────────────────────────────────────────────────────────

const DAY = 24 * 3600 * 1000;
const D0 = Date.UTC(2026, 0, 1); // 2026-01-01

/** Build a daily bar series by iterating a series of "close" prices.
 *  high/low default to +/- 1% of close for testing target-stop crossings. */
function bars(
  asset_id: string,
  closes: number[],
  startMs = D0,
): DailyBar[] {
  return closes.map((close, i) => ({
    asset_id,
    date: new Date(startMs + i * DAY).toISOString().slice(0, 10),
    ts_ms: startMs + i * DAY,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
  }));
}

/** Linear ramp from `from` → `to` over `n` days, inclusive. */
function ramp(from: number, to: number, n: number): number[] {
  if (n < 2) return [from];
  const step = (to - from) / (n - 1);
  return Array.from({ length: n }, (_, i) => from + i * step);
}

// ────────────────────────────────────────────────────────────────────────
// computeMomentumOnlyWeights — pure allocator (signals = 0)
// ────────────────────────────────────────────────────────────────────────

describe("Part 1 — computeMomentumOnlyWeights", () => {
  it("equal-momentum assets get their anchor base weights with no tilt", () => {
    const weights = computeMomentumOnlyWeights({
      asof_ms: D0 + 60 * DAY,
      momentum_30d: new Map([
        ["tok-btc", 0],
        ["tok-eth", 0],
      ]),
      anchors: { "tok-btc": 0.6, "tok-eth": 0.4 },
      tilt_budget: 0,
      non_anchor_cap: 0.05,
      anchor_max: 0.6,
    });
    // 0% momentum → multiplier 1.0 → weights == anchors
    expect(weights.get("tok-btc")).toBeCloseTo(0.6, 2);
    expect(weights.get("tok-eth")).toBeCloseTo(0.4, 2);
  });

  it("strong-momentum asset is tilted up; weak-momentum tilted down", () => {
    const weights = computeMomentumOnlyWeights({
      asof_ms: D0 + 60 * DAY,
      momentum_30d: new Map([
        ["tok-btc", 0.30], // +30% → boost
        ["tok-eth", -0.15], // -15% → trim (above the -25% hard floor)
      ]),
      anchors: { "tok-btc": 0.5, "tok-eth": 0.5 },
      tilt_budget: 0,
      non_anchor_cap: 0.05,
      anchor_max: 0.7,
    });
    expect(weights.get("tok-btc")!).toBeGreaterThan(0.5);
    expect(weights.get("tok-eth")!).toBeLessThan(0.5);
    // After re-normalization to sum-to-1, both still hold.
    const total = [...weights.values()].reduce((s, x) => s + x, 0);
    expect(total).toBeCloseTo(1.0, 5);
  });

  it("anchor with no momentum data falls back to multiplier=1 (anchor weight)", () => {
    const weights = computeMomentumOnlyWeights({
      asof_ms: D0,
      momentum_30d: new Map(), // no data for any asset
      anchors: { "tok-btc": 1.0 },
      tilt_budget: 0,
      non_anchor_cap: 0.05,
      anchor_max: 1.0,
    });
    expect(weights.get("tok-btc")).toBeCloseTo(1.0, 5);
  });

  it("hard floor: assets with -25%+ 30d return are excluded entirely", () => {
    const weights = computeMomentumOnlyWeights({
      asof_ms: D0 + 60 * DAY,
      momentum_30d: new Map([
        ["tok-btc", 0.05],
        ["tok-bad", -0.30], // hard floor
      ]),
      anchors: { "tok-btc": 0.5, "tok-bad": 0.5 },
      tilt_budget: 0,
      non_anchor_cap: 0.05,
      anchor_max: 1.0,
    });
    // Floored asset is dropped from the portfolio; its weight redistributed.
    expect(weights.get("tok-bad")).toBeUndefined();
    expect(weights.get("tok-btc")).toBeCloseTo(1.0, 5);
  });
});

// ────────────────────────────────────────────────────────────────────────
// walkPriceSeries — simulates daily mark-to-market with weekly rebalances
// ────────────────────────────────────────────────────────────────────────

describe("Part 1 — walkPriceSeries (NAV / drawdown / rebalances)", () => {
  it("flat prices → flat NAV, near-zero return", () => {
    // 60 days of constant 100 price for the only asset (BTC anchor).
    const series = new Map<string, DailyBar[]>([
      ["tok-btc", bars("tok-btc", Array(60).fill(100))],
    ]);
    const r = walkPriceSeries({
      start_ms: D0,
      end_ms: D0 + 59 * DAY,
      series,
      anchors: { "tok-btc": 1.0 },
      starting_nav: 10_000,
      rebalance_freq_days: 7,
    });
    expect(r.daily_nav.length).toBe(60);
    // Final NAV ≈ starting NAV (flat)
    expect(r.daily_nav[r.daily_nav.length - 1].nav_usd).toBeCloseTo(10_000, 0);
    // Return near zero
    expect(Math.abs(r.return_pct)).toBeLessThan(0.5);
    // Max drawdown also near zero
    expect(Math.abs(r.max_drawdown_pct)).toBeLessThan(0.5);
  });

  it("known 25% drawdown is correctly identified by max_drawdown_pct", () => {
    // 60 bars: 30 days flat at 100, then drop to 75 over 10 days, then recover.
    const closes: number[] = [
      ...Array(30).fill(100),
      ...ramp(100, 75, 10),
      ...ramp(75, 90, 20),
    ];
    const series = new Map<string, DailyBar[]>([
      ["tok-btc", bars("tok-btc", closes)],
    ]);
    const r = walkPriceSeries({
      start_ms: D0,
      end_ms: D0 + (closes.length - 1) * DAY,
      series,
      anchors: { "tok-btc": 1.0 },
      starting_nav: 10_000,
      rebalance_freq_days: 7,
    });
    // Peak NAV = ~10000 at day 30; trough at end of drawdown leg = 7500.
    // Max DD ≈ -25%. Allow a small tolerance for rebalance noise.
    expect(r.max_drawdown_pct).toBeLessThanOrEqual(-20);
    expect(r.max_drawdown_pct).toBeGreaterThanOrEqual(-30);
  });

  it("rebalances are scheduled every N days (no momentum spikes required)", () => {
    const series = new Map<string, DailyBar[]>([
      ["tok-btc", bars("tok-btc", Array(60).fill(100))],
    ]);
    const r = walkPriceSeries({
      start_ms: D0,
      end_ms: D0 + 59 * DAY,
      series,
      anchors: { "tok-btc": 1.0 },
      starting_nav: 10_000,
      rebalance_freq_days: 7,
    });
    // 60 days, weekly rebalance → 9 rebalances (incl. day 0).
    expect(r.rebalance_count).toBeGreaterThanOrEqual(8);
    expect(r.rebalance_count).toBeLessThanOrEqual(10);
  });

  it("two assets with diverging trends: re-weights to favor the rising one", () => {
    // BTC ramps 100→120 over 60 days; ETH drops 100→80.
    const series = new Map<string, DailyBar[]>([
      ["tok-btc", bars("tok-btc", ramp(100, 120, 60))],
      ["tok-eth", bars("tok-eth", ramp(100, 80, 60))],
    ]);
    const r = walkPriceSeries({
      start_ms: D0,
      end_ms: D0 + 59 * DAY,
      series,
      anchors: { "tok-btc": 0.5, "tok-eth": 0.5 },
      starting_nav: 10_000,
      rebalance_freq_days: 7,
    });
    const finalWeights = r.weight_history[r.weight_history.length - 1].weights;
    // After 60 days of divergence, BTC's weight should exceed ETH's.
    expect(finalWeights.get("tok-btc")!).toBeGreaterThan(
      finalWeights.get("tok-eth") ?? 0,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// computeRunMetrics — Sharpe / DD / vs-BTC delta
// ────────────────────────────────────────────────────────────────────────

describe("Part 1 — computeRunMetrics", () => {
  it("computes return, max drawdown, and Sharpe from a NAV series", () => {
    const navs: Array<{ ts_ms: number; nav_usd: number }> = [
      { ts_ms: D0, nav_usd: 10_000 },
      { ts_ms: D0 + DAY, nav_usd: 10_100 },
      { ts_ms: D0 + 2 * DAY, nav_usd: 10_300 },
      { ts_ms: D0 + 3 * DAY, nav_usd: 10_200 },
      { ts_ms: D0 + 4 * DAY, nav_usd: 10_500 },
    ];
    const m = computeRunMetrics(navs);
    // Final NAV / starting NAV − 1 = +5%
    expect(m.return_pct).toBeCloseTo(5, 1);
    // Max drawdown: peak 10300 → trough 10200 → −0.97%
    expect(m.max_drawdown_pct).toBeLessThanOrEqual(0);
    expect(m.max_drawdown_pct).toBeGreaterThan(-2);
    // Sharpe: positive returns, low variance → > 0
    expect(m.sharpe).toBeGreaterThan(0);
  });

  it("returns null Sharpe when only one data point (cannot compute returns)", () => {
    const m = computeRunMetrics([{ ts_ms: D0, nav_usd: 10_000 }]);
    expect(m.sharpe).toBeNull();
  });

  it("computes vs-BTC alpha when btc_navs provided", () => {
    const navs = ramp(10_000, 12_000, 30).map((n, i) => ({
      ts_ms: D0 + i * DAY,
      nav_usd: n,
    }));
    const btcNavs = ramp(10_000, 11_000, 30).map((n, i) => ({
      ts_ms: D0 + i * DAY,
      nav_usd: n,
    }));
    const m = computeRunMetrics(navs, btcNavs);
    // AlphaIndex +20%, BTC +10%, alpha = +10%
    expect(m.alpha_vs_btc_pct).toBeCloseTo(10, 0);
  });
});
