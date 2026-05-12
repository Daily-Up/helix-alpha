/**
 * v2 framework — drawdown circuit breaker tests.
 *
 * Hard mechanical rules — no discretion:
 *   DD <= -8%  →  HALVED  : satellite weights × 0.5, BTC anchor untouched
 *   DD <= -12% →  ZEROED  : all satellites → 0%, BTC anchor untouched
 *   Recovery to within -4% of peak → reset to NORMAL
 *
 * Why BTC anchor is exempt: BTC is the de-facto market beta. Selling
 * the anchor at a -12% drawdown is exactly the wrong move. The breaker
 * pulls the satellite alpha bets while the anchor rides the cycle.
 */

import { describe, expect, it } from "vitest";
import {
  applyCircuitBreaker,
  shouldExitBreaker,
  type BreakerStatus,
} from "@/lib/alphaindex/v2/circuit-breaker";

const BTC = "tok-btc";

describe("v2 circuit breaker — drawdown thresholds", () => {
  it("DD = -5% (above -8% threshold) → NORMAL, weights untouched", () => {
    const r = applyCircuitBreaker({
      current_nav: 9_500,
      peak_nav: 10_000,
      weights: { [BTC]: 0.50, "tok-eth": 0.10, "tok-sol": 0.05 },
      btc_anchor_id: BTC,
    });
    expect(r.state).toBe("normal");
    expect(r.weights["tok-eth"]).toBeCloseTo(0.10);
    expect(r.weights["tok-sol"]).toBeCloseTo(0.05);
    expect(r.freed_to_cash).toBeCloseTo(0);
  });

  it("DD = -8% → HALVED, satellites cut by 50%, BTC anchor unchanged", () => {
    const r = applyCircuitBreaker({
      current_nav: 9_200,
      peak_nav: 10_000,
      weights: { [BTC]: 0.50, "tok-eth": 0.10, "tok-sol": 0.05 },
      btc_anchor_id: BTC,
    });
    expect(r.state).toBe("halved");
    expect(r.weights[BTC]).toBeCloseTo(0.50); // anchor untouched
    expect(r.weights["tok-eth"]).toBeCloseTo(0.05);
    expect(r.weights["tok-sol"]).toBeCloseTo(0.025);
    // Freed = (0.10 + 0.05) × 0.5 = 0.075
    expect(r.freed_to_cash).toBeCloseTo(0.075);
  });

  it("DD = -12% → ZEROED, satellites = 0, BTC anchor unchanged", () => {
    const r = applyCircuitBreaker({
      current_nav: 8_800,
      peak_nav: 10_000,
      weights: { [BTC]: 0.50, "tok-eth": 0.10, "tok-sol": 0.05 },
      btc_anchor_id: BTC,
    });
    expect(r.state).toBe("zeroed");
    expect(r.weights[BTC]).toBeCloseTo(0.50);
    expect(r.weights["tok-eth"]).toBe(0);
    expect(r.weights["tok-sol"]).toBe(0);
    expect(r.freed_to_cash).toBeCloseTo(0.15);
  });

  it("DD = -20% (below ZEROED threshold) → still ZEROED (no further state)", () => {
    const r = applyCircuitBreaker({
      current_nav: 8_000,
      peak_nav: 10_000,
      weights: { [BTC]: 0.50, "tok-eth": 0.10 },
      btc_anchor_id: BTC,
    });
    expect(r.state).toBe("zeroed");
    expect(r.weights["tok-eth"]).toBe(0);
  });
});

describe("v2 circuit breaker — recovery / shouldExitBreaker", () => {
  it("HALVED state stays active until DD recovers to within -4% of peak", () => {
    expect(shouldExitBreaker("halved" as BreakerStatus, -7)).toBe(false);
    expect(shouldExitBreaker("halved" as BreakerStatus, -5)).toBe(false);
    expect(shouldExitBreaker("halved" as BreakerStatus, -3.99)).toBe(true);
    expect(shouldExitBreaker("halved" as BreakerStatus, -1)).toBe(true);
  });

  it("ZEROED state requires same -4% recovery to exit", () => {
    expect(shouldExitBreaker("zeroed" as BreakerStatus, -10)).toBe(false);
    expect(shouldExitBreaker("zeroed" as BreakerStatus, -3)).toBe(true);
  });

  it("NORMAL state never 'exits' — already normal", () => {
    expect(shouldExitBreaker("normal" as BreakerStatus, 0)).toBe(false);
    expect(shouldExitBreaker("normal" as BreakerStatus, -100)).toBe(false);
  });
});

describe("v2 circuit breaker — defensive edge cases", () => {
  it("zero peak_nav → no drawdown, NORMAL", () => {
    const r = applyCircuitBreaker({
      current_nav: 100,
      peak_nav: 0,
      weights: { [BTC]: 0.50, "tok-eth": 0.10 },
      btc_anchor_id: BTC,
    });
    expect(r.state).toBe("normal");
  });

  it("current >= peak → DD = 0, NORMAL, no scaling", () => {
    const r = applyCircuitBreaker({
      current_nav: 11_000,
      peak_nav: 10_000,
      weights: { [BTC]: 0.50, "tok-eth": 0.10 },
      btc_anchor_id: BTC,
    });
    expect(r.state).toBe("normal");
    expect(r.weights["tok-eth"]).toBeCloseTo(0.10);
  });
});
