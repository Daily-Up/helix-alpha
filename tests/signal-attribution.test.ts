/**
 * Part 3 regression — signal P&L attribution.
 *
 * The attribution engine answers "did news signals add value vs.
 * momentum alone?" It does this by comparing the actual weights
 * (with signals applied) against the counterfactual weights
 * (signals=0, momentum-only) per rebalance, and tallying the
 * realized P&L of the delta over the holding window.
 *
 * Tests cover:
 *   1. Weight delta math (actual − counterfactual, in bps)
 *   2. Realized P&L over a price trajectory
 *   3. Sanity check — garbage counterfactual gets zeroed, not displayed
 *   4. Edge case: zero signals → zero attribution everywhere
 *   5. Multiple assets, mixed positive/negative attribution
 */

import { describe, expect, it } from "vitest";
import {
  computeAttribution,
  realizedAttributionPnL,
  attributionSummary,
} from "@/lib/alphaindex/signal-attribution";

describe("Part 3 — weight-delta math", () => {
  it("delta in bps is (actual − counterfactual) × 10000, rounded to int", () => {
    const r = computeAttribution({
      asof_ms: 1000,
      actual_weights: { "tok-btc": 0.30, "tok-eth": 0.18, "tok-sol": 0.05 },
      counterfactual_weights: { "tok-btc": 0.28, "tok-eth": 0.16, "tok-sol": 0 },
      pre_nav_usd: 10_000,
    });
    expect(r.sanity_ok).toBe(true);
    expect(r.weight_deltas_bps["tok-btc"]).toBe(200); // +2%
    expect(r.weight_deltas_bps["tok-eth"]).toBe(200); // +2%
    expect(r.weight_deltas_bps["tok-sol"]).toBe(500); // new tilt pick
  });

  it("zero signals → zero deltas → empty attribution map", () => {
    const r = computeAttribution({
      asof_ms: 1000,
      actual_weights: { "tok-btc": 0.28, "tok-eth": 0.16 },
      counterfactual_weights: { "tok-btc": 0.28, "tok-eth": 0.16 },
      pre_nav_usd: 10_000,
    });
    expect(r.sanity_ok).toBe(true);
    expect(Object.keys(r.weight_deltas_bps).length).toBe(0);
  });

  it("negative attribution: signal pushed weight DOWN", () => {
    // Counterfactual would have held more; signals tilted weight away.
    const r = computeAttribution({
      asof_ms: 1000,
      actual_weights: { "tok-btc": 0.20 },
      counterfactual_weights: { "tok-btc": 0.28 },
      pre_nav_usd: 10_000,
    });
    expect(r.weight_deltas_bps["tok-btc"]).toBe(-800); // signal cut 8%
  });
});

describe("Part 3 — sanity check (garbage counterfactual)", () => {
  it("counterfactual sums >100% → sanity_ok=false, deltas empty", () => {
    const r = computeAttribution({
      asof_ms: 1000,
      actual_weights: { "tok-btc": 0.30 },
      // 1.5 total: indicates a bug upstream, not a real comparison
      counterfactual_weights: { "tok-btc": 0.5, "tok-eth": 0.5, "tok-sol": 0.5 },
      pre_nav_usd: 10_000,
    });
    expect(r.sanity_ok).toBe(false);
    expect(Object.keys(r.weight_deltas_bps).length).toBe(0);
  });

  it("counterfactual with negative weights → sanity_ok=false", () => {
    const r = computeAttribution({
      asof_ms: 1000,
      actual_weights: { "tok-btc": 0.30 },
      counterfactual_weights: { "tok-btc": -0.10 },
      pre_nav_usd: 10_000,
    });
    expect(r.sanity_ok).toBe(false);
  });
});

describe("Part 3 — realized P&L from a weight delta", () => {
  it("attribution P&L = pre_nav × delta_w × (px_end/px_start − 1)", () => {
    // pre_nav 10k, delta_w +500bps (5%), price up 10% → +50 USD attribution
    const pnl = realizedAttributionPnL(10_000, 500, 100, 110);
    expect(pnl).toBeCloseTo(50, 6);
  });

  it("flat price → zero attribution P&L regardless of delta", () => {
    const pnl = realizedAttributionPnL(10_000, 1000, 100, 100);
    expect(pnl).toBe(0);
  });

  it("negative delta + price-up → negative attribution P&L (signal hurt)", () => {
    // We underweighted by 200 bps; price rose 10% → we missed 0.2% × 10k = -20
    const pnl = realizedAttributionPnL(10_000, -200, 100, 110);
    expect(pnl).toBeCloseTo(-20, 6);
  });

  it("negative delta + price-down → positive attribution P&L (signal helped)", () => {
    // We underweighted by 200 bps and price fell 10% → we avoided -0.2% × 10k = +20
    const pnl = realizedAttributionPnL(10_000, -200, 100, 90);
    expect(pnl).toBeCloseTo(20, 6);
  });

  it("zero pre_nav or zero start price → zero P&L (defensive)", () => {
    expect(realizedAttributionPnL(0, 500, 100, 110)).toBe(0);
    expect(realizedAttributionPnL(10_000, 500, 0, 110)).toBe(0);
    expect(realizedAttributionPnL(10_000, 500, 100, 0)).toBe(0);
  });
});

describe("Part 3 — attribution summary aggregator", () => {
  it("sums realized P&L across assets and reports total + per-asset", () => {
    const summary = attributionSummary([
      { asset_id: "tok-btc", weight_delta_bps: 500, pnl_usd: 50 },
      { asset_id: "tok-eth", weight_delta_bps: -200, pnl_usd: 20 },
      { asset_id: "tok-sol", weight_delta_bps: 300, pnl_usd: -15 },
    ]);
    expect(summary.total_pnl_usd).toBeCloseTo(55, 6);
    expect(summary.winners).toHaveLength(2); // btc + eth
    expect(summary.losers).toHaveLength(1); // sol
    expect(summary.winners[0].asset_id).toBe("tok-btc"); // largest first
  });

  it("empty input → zero total and empty arrays", () => {
    const summary = attributionSummary([]);
    expect(summary.total_pnl_usd).toBe(0);
    expect(summary.winners).toEqual([]);
    expect(summary.losers).toEqual([]);
  });
});

describe("Part 3 — end-to-end: rebalance → attribution → P&L", () => {
  it("full flow with two rebalances and a known price trajectory", () => {
    // Setup: starting NAV 10k. Actual weights at T=0: BTC 30% (signal-boosted),
    // ETH 18% (signal-boosted). Counterfactual: BTC 28%, ETH 16% (anchor only).
    const r1 = computeAttribution({
      asof_ms: 0,
      actual_weights: { "tok-btc": 0.30, "tok-eth": 0.18 },
      counterfactual_weights: { "tok-btc": 0.28, "tok-eth": 0.16 },
      pre_nav_usd: 10_000,
    });
    // Deltas: BTC +200bps, ETH +200bps
    expect(r1.weight_deltas_bps["tok-btc"]).toBe(200);
    expect(r1.weight_deltas_bps["tok-eth"]).toBe(200);

    // Between T=0 and T=1 BTC moves 100→120 (+20%), ETH moves 100→90 (−10%).
    const btcPnl = realizedAttributionPnL(
      10_000,
      r1.weight_deltas_bps["tok-btc"],
      100,
      120,
    );
    const ethPnl = realizedAttributionPnL(
      10_000,
      r1.weight_deltas_bps["tok-eth"],
      100,
      90,
    );
    // BTC: 10k × 0.02 × 0.20 = +40
    expect(btcPnl).toBeCloseTo(40, 6);
    // ETH: 10k × 0.02 × −0.10 = −20
    expect(ethPnl).toBeCloseTo(-20, 6);

    // Net signal contribution this period: +20 USD on a 10k NAV
    const summary = attributionSummary([
      { asset_id: "tok-btc", weight_delta_bps: 200, pnl_usd: btcPnl },
      { asset_id: "tok-eth", weight_delta_bps: 200, pnl_usd: ethPnl },
    ]);
    expect(summary.total_pnl_usd).toBeCloseTo(20, 6);
  });
});
