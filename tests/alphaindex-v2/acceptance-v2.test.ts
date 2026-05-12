/**
 * v2.1 acceptance — C3 (capture) + C4 (bear DD reduction) regression.
 *
 * These criteria replaced C3a (Sharpe ≥ BTC Sharpe) which was
 * structurally incompatible with a long-only, BTC-anchored framework.
 * The new criteria split the test by regime: capture in non-bear,
 * drawdown reduction in bear. See acceptance.ts JSDoc.
 */

import { describe, expect, it } from "vitest";
import {
  evaluateAcceptance,
  type StressWindowResult,
} from "@/lib/alphaindex/v2/acceptance";

function w(
  label: string,
  v2Ret: number,
  btcRet: number,
  v2DD: number,
  btcDD: number,
): StressWindowResult {
  return {
    label,
    start_date: "2025-01-01",
    end_date: "2025-03-01",
    v2_max_dd_pct: v2DD,
    btc_max_dd_pct: btcDD,
    v2_return_pct: v2Ret,
    btc_return_pct: btcRet,
    v2_sharpe: 1,
    btc_sharpe: 1,
  };
}

const livePassing = {
  v2_live_return_pct: 8,
  v2_live_max_dd_pct: -2,
  btc_live_return_pct: 10,
  btc_live_max_dd_pct: -5, // C2 DD-beat: -2 < 0.7 × -5 = -3.5 ✓
};

describe("v2.1 acceptance — C3 capture-ratio classification", () => {
  it("classifies BTC return ≥ 0 as non-bear (zero excluded)", () => {
    const result = evaluateAcceptance({
      index_id: "test",
      stress_windows: [
        w("up", 6, 10, -3, -8),    // capture 60% (non-bear)
        w("flat", 0, 0, -5, -8),    // BTC=0 → excluded
        w("down", -10, -20, -10, -25), // bear
      ],
      ...livePassing,
    });
    const c3 = result.criteria.find((c) => c.key === "C3_capture")!;
    // Only "up" counts → 60% capture → passes
    expect(c3.passed).toBe(true);
    expect(c3.observed).toBeCloseTo(0.6, 2);
  });

  it("computes mean capture across multiple non-bear windows", () => {
    const result = evaluateAcceptance({
      index_id: "test",
      stress_windows: [
        w("a", 8, 10, -3, -8),  // 80%
        w("b", 4, 10, -3, -8),  // 40%
        w("c", 7, 10, -3, -8),  // 70%
      ],
      ...livePassing,
    });
    const c3 = result.criteria.find((c) => c.key === "C3_capture")!;
    // mean = (0.8 + 0.4 + 0.7)/3 = 0.633 → passes
    expect(c3.observed).toBeCloseTo(0.633, 2);
    expect(c3.passed).toBe(true);
  });

  it("fails when mean capture < 50%", () => {
    const result = evaluateAcceptance({
      index_id: "test",
      stress_windows: [
        w("low", 2, 10, -3, -8), // 20%
        w("low2", 3, 10, -3, -8), // 30%
      ],
      ...livePassing,
    });
    const c3 = result.criteria.find((c) => c.key === "C3_capture")!;
    expect(c3.passed).toBe(false);
    expect(c3.observed).toBeCloseTo(0.25, 2);
  });

  it("edge: all bear windows → C3 has no data → 'n/a passing'", () => {
    const result = evaluateAcceptance({
      index_id: "test",
      stress_windows: [
        w("bear1", -10, -20, -12, -25),
        w("bear2", -8, -15, -10, -20),
      ],
      ...livePassing,
    });
    const c3 = result.criteria.find((c) => c.key === "C3_capture")!;
    expect(c3.passed).toBe(true);
    expect(c3.detail).toMatch(/n\/a/);
  });
});

describe("v2.1 acceptance — C4 bear DD reduction", () => {
  it("passes when worst bear ratio ≤ 0.7", () => {
    const result = evaluateAcceptance({
      index_id: "test",
      stress_windows: [
        w("bear1", -10, -20, -12, -25), // 12/25 = 0.48
        w("bear2", -8, -15, -10, -20),  // 10/20 = 0.50
      ],
      ...livePassing,
    });
    const c4 = result.criteria.find((c) => c.key === "C4_bear_dd_reduction")!;
    expect(c4.passed).toBe(true);
    expect(c4.observed).toBeCloseTo(0.5, 2);
  });

  it("fails when any bear window's ratio > 0.7", () => {
    const result = evaluateAcceptance({
      index_id: "test",
      stress_windows: [
        w("bear_close", -18, -20, -19, -22), // 19/22 ≈ 0.86 — fails
        w("bear_ok", -8, -15, -10, -20),     // 0.50
      ],
      ...livePassing,
    });
    const c4 = result.criteria.find((c) => c.key === "C4_bear_dd_reduction")!;
    expect(c4.passed).toBe(false);
    expect(c4.observed).toBeGreaterThan(0.7);
  });

  it("only considers BEAR windows (BTC ret < 0); non-bears ignored", () => {
    const result = evaluateAcceptance({
      index_id: "test",
      stress_windows: [
        // Even though v2 DD is large here, BTC ret > 0 so it isn't bear.
        w("trending_w_drawdown", 5, 10, -25, -8),
        w("real_bear", -10, -20, -10, -25), // ratio 0.40
      ],
      ...livePassing,
    });
    const c4 = result.criteria.find((c) => c.key === "C4_bear_dd_reduction")!;
    expect(c4.passed).toBe(true);
    expect(c4.observed).toBeCloseTo(0.4, 2);
  });

  it("edge: all non-bear windows → C4 has no data → 'n/a passing'", () => {
    const result = evaluateAcceptance({
      index_id: "test",
      stress_windows: [
        w("a", 8, 10, -3, -8),
        w("b", 5, 12, -4, -10),
      ],
      ...livePassing,
    });
    const c4 = result.criteria.find((c) => c.key === "C4_bear_dd_reduction")!;
    expect(c4.passed).toBe(true);
    expect(c4.detail).toMatch(/n\/a/);
  });
});

describe("v2.1 acceptance — MARGINAL PASS classification (I-35)", () => {
  it("criterion at 1.04× threshold (max-direction) classified as MARGINAL", () => {
    // C4 threshold = 0.7. 0.728 / 0.7 = 1.04 → within 5% → marginal.
    const result = evaluateAcceptance({
      index_id: "test",
      stress_windows: [
        // Bear with ratio 0.728 (=1.04× of 0.7)
        w("bear_marginal", -10, -20, -14.56, -20),
      ],
      ...livePassing,
    });
    const c4 = result.criteria.find((c) => c.key === "C4_bear_dd_reduction")!;
    expect(c4.status).toBe("marginal");
    expect(c4.passed).toBe(true); // marginal counts as passing
    expect(c4.marginal_note).toMatch(/over threshold/);
  });

  it("criterion at 1.10× threshold (max-direction) classified as FAIL", () => {
    // 0.77 / 0.7 = 1.10 → outside 5% band → hard fail.
    const result = evaluateAcceptance({
      index_id: "test",
      stress_windows: [
        w("bear_fail", -10, -20, -15.4, -20), // ratio 0.77
      ],
      ...livePassing,
    });
    const c4 = result.criteria.find((c) => c.key === "C4_bear_dd_reduction")!;
    expect(c4.status).toBe("fail");
    expect(c4.passed).toBe(false);
  });

  it("overall PASSED when 3 PASS + 1 MARGINAL", () => {
    const result = evaluateAcceptance({
      index_id: "test",
      stress_windows: [
        // Non-bears: capture 80% — clean pass
        w("up", 8, 10, -3, -8),
        // Bear: ratio 0.728 → MARGINAL
        w("bear_marginal", -10, -20, -14.56, -20),
      ],
      ...livePassing,
    });
    expect(result.passed).toBe(true);
    const statuses = result.criteria.map((c) => c.status);
    expect(statuses.filter((s) => s === "marginal").length).toBe(1);
    expect(statuses.filter((s) => s === "fail").length).toBe(0);
  });
});

describe("v2.1 acceptance — overall pass requires all four", () => {
  it("PASS when C1, C2, C3, C4 all pass", () => {
    const result = evaluateAcceptance({
      index_id: "test",
      stress_windows: [
        w("up", 8, 10, -5, -10),         // capture 80%, ratio 0.5
        w("bear", -10, -20, -10, -25),   // bear ratio 0.40
      ],
      ...livePassing,
    });
    expect(result.passed).toBe(true);
    expect(result.criteria.every((c) => c.passed)).toBe(true);
    expect(result.criteria.find((c) => c.key === "C3_capture")).toBeTruthy();
    expect(result.criteria.find((c) => c.key === "C4_bear_dd_reduction")).toBeTruthy();
    // No legacy C3a key on new evaluations.
    expect(result.criteria.find((c) => c.key === "C3_stress_sharpe")).toBeUndefined();
  });

  it("FAIL when one criterion fails (C3) — overall passed=false", () => {
    const result = evaluateAcceptance({
      index_id: "test",
      stress_windows: [
        w("low_capture", 1, 10, -3, -8), // capture 10% — fails C3
        w("bear", -8, -20, -10, -25),    // ratio 0.40 — passes C4
      ],
      ...livePassing,
    });
    expect(result.passed).toBe(false);
    const c3 = result.criteria.find((c) => c.key === "C3_capture")!;
    expect(c3.passed).toBe(false);
  });
});
