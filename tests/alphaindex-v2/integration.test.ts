/**
 * v2 framework — end-to-end integration test.
 *
 * Drives the full v2 engine (regime → allocator → signals →
 * vol-target → breaker) against synthetic price series and asserts:
 *   - drawdown circuit breaker actually fires when prices crash
 *   - BTC anchor weight stays in band across regimes
 *   - no satellite weight ever exceeds MAX_SINGLE_SATELLITE (8%)
 *
 * The harness intentionally does NOT call the real backtest infra —
 * those tests live separately. This test validates the engine
 * composes correctly under stress.
 */

import { describe, expect, it } from "vitest";
import {
  newEngineState,
  runV2Engine,
  type V2EngineState,
} from "@/lib/alphaindex/v2/engine";
import type { DailyBar } from "@/lib/alphaindex/backtest";
import {
  BTC_MIN,
  BTC_MAX,
  MAX_SINGLE_SATELLITE,
  MAX_SINGLE_SATELLITE_TREND,
} from "@/lib/alphaindex/v2/allocator";

const DAY = 24 * 3600 * 1000;
const D0 = Date.UTC(2026, 0, 1);
const BTC = "tok-btc";

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

function buildSeries(closesByAsset: Record<string, number[]>): Map<string, DailyBar[]> {
  const m = new Map<string, DailyBar[]>();
  for (const [k, v] of Object.entries(closesByAsset)) m.set(k, bars(k, v));
  return m;
}

describe("v2 engine — invariants under simulated runs", () => {
  it("BTC anchor stays in [40%, 70%] across a 60d run with mixed regimes", () => {
    // BTC ramps up first half, drops in second half.
    const btcCloses = [...ramp(100, 130, 30), ...ramp(130, 100, 30)];
    const series = buildSeries({
      [BTC]: btcCloses,
      "tok-eth": ramp(100, 110, 60),
      "tok-sol": ramp(100, 105, 60),
      "rwa-xaut": ramp(100, 102, 60),
    });

    let state: V2EngineState = newEngineState();
    let nav = 10_000;
    for (let d = 30; d < 60; d++) {
      const result = runV2Engine({
        asof_ms: D0 + d * DAY,
        series,
        current_nav: nav,
        signals: [],
        state,
      });
      const btcW = result.weights[BTC] ?? 0;
      // Allow a bit of slack for vol-targeting clamps
      expect(btcW).toBeGreaterThanOrEqual(BTC_MIN - 1e-6);
      expect(btcW).toBeLessThanOrEqual(BTC_MAX + 1e-6);
      // Per-asset cap is regime-aware (v2.1): TREND→10%, CHOP/DRAWDOWN→8%.
      const cap =
        result.meta.regime === "TREND"
          ? MAX_SINGLE_SATELLITE_TREND
          : MAX_SINGLE_SATELLITE;
      for (const [k, w] of Object.entries(result.weights)) {
        if (k === BTC) continue;
        expect(w).toBeLessThanOrEqual(cap + 1e-6);
      }
      state = result.next_state;
      // simulate NAV moving with weights × prices (simplified to ~flat)
      nav *= 1 + 0.001 * (Math.random() - 0.5);
    }
  });

  it("circuit breaker fires when NAV drops > 12% from peak", () => {
    const series = buildSeries({
      [BTC]: ramp(100, 90, 60), // BTC -10%
      "tok-eth": ramp(100, 60, 60), // ETH crashes -40%
      "tok-sol": ramp(100, 50, 60),
    });

    let state: V2EngineState = newEngineState();
    let nav = 10_000;
    state.peak_nav = 10_000;
    let breakerFired = false;

    for (let d = 30; d < 60; d++) {
      // Simulate NAV drop to -15% from peak
      if (d === 45) nav = 8_500;
      const result = runV2Engine({
        asof_ms: D0 + d * DAY,
        series,
        current_nav: nav,
        signals: [],
        state,
      });
      if (result.meta.breaker !== "normal") breakerFired = true;
      // Once ZEROED, satellites should be ~0
      if (result.meta.breaker === "zeroed") {
        for (const [k, w] of Object.entries(result.weights)) {
          if (k === BTC) continue;
          expect(w).toBeCloseTo(0, 6);
        }
      }
      state = result.next_state;
    }
    expect(breakerFired).toBe(true);
  });

  it("DRAWDOWN regime queues bullish signals (does not apply them)", () => {
    // Steep BTC drop → DRAWDOWN regime
    const btcCloses = [...ramp(100, 100, 10), ...ramp(100, 80, 20), ...ramp(80, 78, 30)];
    const series = buildSeries({
      [BTC]: btcCloses,
      "tok-eth": ramp(100, 95, 60),
      "rwa-xaut": ramp(100, 105, 60),
    });

    let state: V2EngineState = newEngineState();
    // Force regime into DRAWDOWN by simulating multiple days
    for (let d = 30; d < 50; d++) {
      const r = runV2Engine({
        asof_ms: D0 + d * DAY,
        series,
        current_nav: 10_000,
        signals: [],
        state,
      });
      state = r.next_state;
    }
    expect(state.regime.current).toBe("DRAWDOWN");

    // Now feed a bullish signal — should be queued, not applied
    const r2 = runV2Engine({
      asof_ms: D0 + 50 * DAY,
      series,
      current_nav: 10_000,
      signals: [{ asset_id: "tok-eth", signed_score: 5.0 }],
      state,
    });
    expect(r2.meta.queued_signals).toBe(1);
  });
});
