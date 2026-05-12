/**
 * v2 framework — regime detection tests.
 *
 * Three regimes:
 *   TREND     — BTC 30d momentum > +5% AND vol < high threshold
 *   CHOP      — neither trending nor in drawdown
 *   DRAWDOWN  — BTC down >10% from 30d high OR vol elevated
 *
 * Transitions are smoothed: requires 3 consecutive days observing the
 * new regime before switching. This prevents single-day flips during
 * choppy periods.
 */

import { describe, expect, it } from "vitest";
import {
  classifyRawRegime,
  applyRegimeSmoothing,
  newRegimeState,
} from "@/lib/alphaindex/v2/regime";

function ramp(from: number, to: number, n: number): number[] {
  if (n < 2) return [from];
  const step = (to - from) / (n - 1);
  return Array.from({ length: n }, (_, i) => from + i * step);
}

function noisy(level: number, n: number, amp = 0.02): number[] {
  // Deterministic pseudo-random: sin wave + flat trend.
  return Array.from({ length: n }, (_, i) => level * (1 + amp * Math.sin(i * 1.7)));
}

describe("v2 regime — raw classification", () => {
  it("classifies a strong uptrend as TREND", () => {
    // 30d ramp from 100 → 120 (+20%), low vol
    const closes = ramp(100, 120, 30);
    expect(classifyRawRegime(closes)).toBe("TREND");
  });

  it("classifies a flat market as CHOP", () => {
    const closes = noisy(100, 30, 0.005); // <1% noise, no trend
    expect(classifyRawRegime(closes)).toBe("CHOP");
  });

  it("classifies a deep drop as DRAWDOWN (peak-to-current > 10%)", () => {
    // First 15 days flat at 110, then drop to 90 → peak 110, last 90, dd ~-18%
    const closes = [...Array(15).fill(110), ...ramp(110, 90, 15)];
    expect(classifyRawRegime(closes)).toBe("DRAWDOWN");
  });

  it("classifies elevated-vol periods as DRAWDOWN even with positive momentum", () => {
    // Whipsaw: each day swings ±15% but ends near start
    const closes = Array.from({ length: 30 }, (_, i) =>
      100 * (1 + 0.15 * Math.sin(i * 1.3)),
    );
    expect(classifyRawRegime(closes)).toBe("DRAWDOWN");
  });

  it("returns CHOP for insufficient history", () => {
    expect(classifyRawRegime([100, 101, 102])).toBe("CHOP");
    expect(classifyRawRegime([])).toBe("CHOP");
  });
});

describe("v2 regime — smoothing prevents single-day flips", () => {
  it("requires 3 consecutive days of new regime before switching", () => {
    let s = newRegimeState("CHOP");
    // Single TREND day shouldn't flip
    s = applyRegimeSmoothing(s, "TREND");
    expect(s.current).toBe("CHOP");
    s = applyRegimeSmoothing(s, "TREND");
    expect(s.current).toBe("CHOP");
    // Third consecutive — flip
    s = applyRegimeSmoothing(s, "TREND");
    expect(s.current).toBe("TREND");
  });

  it("resets pending streak when a different regime appears", () => {
    let s = newRegimeState("CHOP");
    s = applyRegimeSmoothing(s, "TREND");
    s = applyRegimeSmoothing(s, "TREND");
    // Different regime — streak resets
    s = applyRegimeSmoothing(s, "DRAWDOWN");
    expect(s.current).toBe("CHOP");
    expect(s.pending).toBe("DRAWDOWN");
    expect(s.pending_streak).toBe(1);
  });

  it("keeps current regime when same regime continues", () => {
    let s = newRegimeState("TREND");
    for (let i = 0; i < 10; i++) {
      s = applyRegimeSmoothing(s, "TREND");
    }
    expect(s.current).toBe("TREND");
    expect(s.days_in_current).toBe(10);
  });

  it("transition: TREND → DRAWDOWN takes 3 days of confirmation", () => {
    let s = newRegimeState("TREND");
    s = applyRegimeSmoothing(s, "DRAWDOWN");
    s = applyRegimeSmoothing(s, "DRAWDOWN");
    expect(s.current).toBe("TREND"); // not yet
    s = applyRegimeSmoothing(s, "DRAWDOWN");
    expect(s.current).toBe("DRAWDOWN");
    expect(s.days_in_current).toBe(1);
  });
});

describe("v2.1 regime — asymmetric DRAWDOWN→TREND exit (1-day)", () => {
  it("DRAWDOWN → TREND switches after just 1 day", () => {
    let s = newRegimeState("DRAWDOWN");
    s = applyRegimeSmoothing(s, "TREND");
    // Single day of confirmation is enough for this specific transition.
    expect(s.current).toBe("TREND");
    expect(s.days_in_current).toBe(1);
  });

  it("DRAWDOWN → CHOP still requires 3-day confirmation", () => {
    let s = newRegimeState("DRAWDOWN");
    s = applyRegimeSmoothing(s, "CHOP");
    expect(s.current).toBe("DRAWDOWN");
    s = applyRegimeSmoothing(s, "CHOP");
    expect(s.current).toBe("DRAWDOWN");
    s = applyRegimeSmoothing(s, "CHOP");
    expect(s.current).toBe("CHOP");
  });

  it("TREND → DRAWDOWN entrance still requires 3 days (asymmetry is exit-only)", () => {
    let s = newRegimeState("TREND");
    s = applyRegimeSmoothing(s, "DRAWDOWN");
    s = applyRegimeSmoothing(s, "DRAWDOWN");
    expect(s.current).toBe("TREND");
    s = applyRegimeSmoothing(s, "DRAWDOWN");
    expect(s.current).toBe("DRAWDOWN");
  });
});
