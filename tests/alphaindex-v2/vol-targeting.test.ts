/**
 * v2 framework — portfolio vol-targeting tests.
 *
 * Target portfolio vol = 40% annualized. Triggers:
 *   - realized_vol > 1.2 × target → scale down (move toward cash)
 *   - realized_vol < 0.8 × target → scale up (deploy cash)
 *
 * Scaling is uniform across non-cash positions, preserving the
 * relative weights — only the cash/notional ratio changes.
 */

import { describe, expect, it } from "vitest";
import {
  applyVolTarget,
  computeRealizedVol,
  TARGET_VOL,
} from "@/lib/alphaindex/v2/vol-targeting";

describe("v2 vol-targeting — realized vol calculation", () => {
  it("returns 0 for insufficient history", () => {
    expect(computeRealizedVol([])).toBe(0);
    expect(computeRealizedVol([100])).toBe(0);
  });

  it("flat prices → ~0 vol", () => {
    const closes = Array(30).fill(100);
    expect(computeRealizedVol(closes)).toBeCloseTo(0, 5);
  });

  it("increasing daily volatility produces non-trivial annualized vol", () => {
    // Each day moves 2% — annualized ≈ 0.02 * sqrt(365) ≈ 0.38
    const closes = Array.from({ length: 30 }, (_, i) =>
      100 * (1 + 0.02 * Math.sin(i * 0.7)),
    );
    const v = computeRealizedVol(closes);
    expect(v).toBeGreaterThan(0.1);
    expect(v).toBeLessThan(2.0);
  });
});

describe("v2 vol-targeting — scale-down trigger", () => {
  it("realized_vol > 1.2× target → scales down proportionally", () => {
    // Realized vol = 0.60 → ratio = 1.5 → scale = TARGET / 0.60
    const r = applyVolTarget({
      weights: { "tok-btc": 0.50, "tok-eth": 0.30 },
      cash_weight: 0.20,
      realized_vol: 0.60,
    });
    expect(r.trigger).toBe("scale_down");
    expect(r.scale_factor).toBeCloseTo(TARGET_VOL / 0.60, 5);
    // Relative ratio btc/eth preserved (5/3)
    expect(r.scaled_weights["tok-btc"] / r.scaled_weights["tok-eth"]).toBeCloseTo(0.50 / 0.30, 5);
    expect(r.scaled_cash).toBeGreaterThan(0.20); // cash grows
  });

  it("preserves relative position weights when scaling down", () => {
    const r = applyVolTarget({
      weights: { "a": 0.40, "b": 0.20, "c": 0.10 },
      cash_weight: 0.30,
      realized_vol: 0.80, // 2× target
    });
    expect(r.scaled_weights.a / r.scaled_weights.b).toBeCloseTo(2.0, 5);
    expect(r.scaled_weights.b / r.scaled_weights.c).toBeCloseTo(2.0, 5);
  });
});

describe("v2 vol-targeting — scale-up trigger", () => {
  it("realized_vol < 0.8× target with cash available → scales up", () => {
    const r = applyVolTarget({
      weights: { "tok-btc": 0.40, "tok-eth": 0.20 },
      cash_weight: 0.40,
      realized_vol: 0.20, // ratio 0.5 — below 0.8× target
    });
    expect(r.trigger).toBe("scale_up");
    expect(r.scale_factor).toBeGreaterThan(1.0);
    expect(r.scaled_cash).toBeLessThan(0.40);
  });

  it("scale-up never deploys more than 100% (cash floor at 0)", () => {
    const r = applyVolTarget({
      weights: { "tok-btc": 0.50, "tok-eth": 0.20 },
      cash_weight: 0.30,
      realized_vol: 0.05, // extremely low → unbounded scale
    });
    expect(r.scaled_cash).toBeGreaterThanOrEqual(0);
    const sum = Object.values(r.scaled_weights).reduce((s, x) => s + x, 0);
    expect(sum + r.scaled_cash).toBeCloseTo(1.0, 5);
  });
});

describe("v2.1 vol-targeting — TREND-asymmetric scale-up", () => {
  it("TREND regime: scale-up triggers at ratio < 1.0 (vs 0.8 default)", () => {
    // Vol = 0.36 → ratio = 0.9. Default thresholds → no scale; TREND → scale-up.
    const baseInputs = {
      weights: { "tok-btc": 0.50, "tok-eth": 0.10 },
      cash_weight: 0.40,
      realized_vol: 0.36,
    };
    const def = applyVolTarget({ ...baseInputs }); // no regime
    expect(def.trigger).toBeNull();
    expect(def.scale_factor).toBe(1.0);

    const trend = applyVolTarget({ ...baseInputs, regime: "TREND" });
    expect(trend.trigger).toBe("scale_up");
    expect(trend.scale_factor).toBeGreaterThan(1.0);
  });

  it("CHOP regime preserves the original 0.8× scale-up threshold", () => {
    const r = applyVolTarget({
      weights: { "tok-btc": 0.50, "tok-eth": 0.10 },
      cash_weight: 0.40,
      realized_vol: 0.36, // ratio 0.9 — below TREND trigger but above default
      regime: "CHOP",
    });
    expect(r.trigger).toBeNull();
    expect(r.scale_factor).toBe(1.0);
  });

  it("DRAWDOWN regime never scales up early — keeps 0.8× threshold", () => {
    const r = applyVolTarget({
      weights: { "tok-btc": 0.40, "tok-eth": 0.05 },
      cash_weight: 0.55,
      realized_vol: 0.36,
      regime: "DRAWDOWN",
    });
    expect(r.trigger).toBeNull();
  });
});

describe("v2 vol-targeting — neutral band", () => {
  it("0.8× ≤ realized_vol ≤ 1.2× → no scaling", () => {
    const r = applyVolTarget({
      weights: { "tok-btc": 0.50, "tok-eth": 0.30 },
      cash_weight: 0.20,
      realized_vol: 0.40, // exactly target
    });
    expect(r.trigger).toBeNull();
    expect(r.scale_factor).toBe(1.0);
    expect(r.scaled_cash).toBeCloseTo(0.20, 5);
  });
});
