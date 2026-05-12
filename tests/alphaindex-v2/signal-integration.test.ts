/**
 * v2 framework — signal integration tests.
 *
 * News signals influence satellite weights but with bounds:
 *   - Each signal can move a satellite weight by ≤ ±2% absolute (I-34)
 *   - BTC anchor cannot be pushed outside [40%, 70%] band (I-33)
 *   - In DRAWDOWN regime, only bearish/risk-off signals are honored;
 *     bullish signals are queued (no-op for now)
 */

import { describe, expect, it } from "vitest";
import {
  applySignalBoosts,
  MAX_SIGNAL_BOOST,
  type SignalBoostInput,
} from "@/lib/alphaindex/v2/signal-integration";

const BTC = "tok-btc";

function input(
  base: Record<string, number>,
  cash: number,
  signals: SignalBoostInput["signals"],
  regime: SignalBoostInput["regime"] = "TREND",
): SignalBoostInput {
  return {
    base_weights: base,
    base_cash: cash,
    signals,
    regime,
    btc_anchor_id: BTC,
  };
}

describe("v2 signal integration — ±2% bound", () => {
  it("a single bullish signal cannot move a satellite by more than +2%", () => {
    const r = applySignalBoosts(
      input(
        { [BTC]: 0.50, "tok-eth": 0.05 },
        0.45,
        [{ asset_id: "tok-eth", signed_score: 5.0 }], // very strong
      ),
    );
    const delta = r.weights["tok-eth"] - 0.05;
    expect(delta).toBeLessThanOrEqual(MAX_SIGNAL_BOOST + 1e-6);
    expect(delta).toBeGreaterThan(0); // some boost happened
  });

  it("a single bearish signal cannot cut a satellite by more than -2%", () => {
    const r = applySignalBoosts(
      input(
        { [BTC]: 0.50, "tok-eth": 0.07 },
        0.43,
        [{ asset_id: "tok-eth", signed_score: -5.0 }],
      ),
    );
    const delta = r.weights["tok-eth"] - 0.07;
    expect(delta).toBeGreaterThanOrEqual(-MAX_SIGNAL_BOOST - 1e-6);
    expect(delta).toBeLessThan(0);
  });

  it("weak signal (low |score|) produces partial boost (less than 2%)", () => {
    const r = applySignalBoosts(
      input(
        { [BTC]: 0.50, "tok-eth": 0.05 },
        0.45,
        [{ asset_id: "tok-eth", signed_score: 0.5 }], // weak
      ),
    );
    const delta = r.weights["tok-eth"] - 0.05;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(MAX_SIGNAL_BOOST);
  });
});

describe("v2 signal integration — BTC anchor band", () => {
  it("a strong bullish BTC signal cannot push BTC above 70%", () => {
    const r = applySignalBoosts(
      input(
        { [BTC]: 0.69, "tok-eth": 0.05 },
        0.26,
        [{ asset_id: BTC, signed_score: 10.0 }],
      ),
    );
    expect(r.weights[BTC]).toBeLessThanOrEqual(0.70 + 1e-6);
  });

  it("a strong bearish BTC signal cannot push BTC below 40%", () => {
    const r = applySignalBoosts(
      input(
        { [BTC]: 0.42, "tok-eth": 0.05 },
        0.53,
        [{ asset_id: BTC, signed_score: -10.0 }],
      ),
    );
    expect(r.weights[BTC]).toBeGreaterThanOrEqual(0.40 - 1e-6);
  });
});

describe("v2 signal integration — regime gating", () => {
  it("in DRAWDOWN, bullish signals are queued (no-op on weights)", () => {
    const r = applySignalBoosts(
      input(
        { [BTC]: 0.40, "tok-eth": 0.05 },
        0.55,
        [{ asset_id: "tok-eth", signed_score: 3.0 }], // bullish
        "DRAWDOWN",
      ),
    );
    expect(r.weights["tok-eth"]).toBeCloseTo(0.05, 5);
    expect(r.queued_signals.length).toBe(1);
    expect(r.queued_signals[0].asset_id).toBe("tok-eth");
  });

  it("in DRAWDOWN, bearish signals ARE honored (cut weight further)", () => {
    const r = applySignalBoosts(
      input(
        { [BTC]: 0.40, "tok-eth": 0.05 },
        0.55,
        [{ asset_id: "tok-eth", signed_score: -3.0 }],
        "DRAWDOWN",
      ),
    );
    expect(r.weights["tok-eth"]).toBeLessThan(0.05);
    expect(r.queued_signals.length).toBe(0);
  });

  it("in TREND, both bullish and bearish signals are applied", () => {
    const r = applySignalBoosts(
      input(
        { [BTC]: 0.50, "tok-eth": 0.05, "tok-sol": 0.05 },
        0.40,
        [
          { asset_id: "tok-eth", signed_score: 3.0 },
          { asset_id: "tok-sol", signed_score: -2.0 },
        ],
        "TREND",
      ),
    );
    expect(r.weights["tok-eth"]).toBeGreaterThan(0.05);
    expect(r.weights["tok-sol"]).toBeLessThan(0.05);
    expect(r.queued_signals.length).toBe(0);
  });
});

describe("v2 signal integration — conservation", () => {
  it("weights + cash sum to 1 after boost", () => {
    const r = applySignalBoosts(
      input(
        { [BTC]: 0.50, "tok-eth": 0.05, "tok-sol": 0.05 },
        0.40,
        [
          { asset_id: "tok-eth", signed_score: 2.0 },
          { asset_id: "tok-sol", signed_score: -2.0 },
        ],
      ),
    );
    const total = Object.values(r.weights).reduce((s, x) => s + x, 0) + r.cash_weight;
    expect(total).toBeCloseTo(1.0, 5);
  });
});
