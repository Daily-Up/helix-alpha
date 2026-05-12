/**
 * v2 framework — allocator composition tests.
 *
 * The allocator combines Fix 1 (BTC anchor + bounds), Fix 3 (regime
 * params), and Fix 4 (concentration limits + tail pruning). It does
 * NOT yet apply vol-targeting (Fix 2), the circuit breaker (Fix 5),
 * or signal boosts (Fix 6) — those are layered on by the engine.
 *
 * Per-regime base targets:
 *   TREND     → BTC 50%, satellites 45%, cash 5%
 *   CHOP      → BTC 60%, satellites 30%, cash 10%
 *   DRAWDOWN  → BTC 40%, satellites 15% (defensives), cash 45%
 *
 * Concentration:
 *   - Max single satellite: 8%
 *   - Max thematic cluster: 15%
 *   - Min position: 3%   (anything smaller pruned)
 *   - Max satellite count: 10
 */

import { describe, expect, it } from "vitest";
import {
  allocateV2,
  type SatelliteCandidate,
  MAX_SINGLE_SATELLITE,
  MAX_SINGLE_SATELLITE_TREND,
  MAX_CLUSTER,
  MAX_CLUSTER_TREND,
  MIN_POSITION,
  MAX_SATELLITES,
  BTC_MIN,
  BTC_MAX,
} from "@/lib/alphaindex/v2/allocator";

const BTC = "tok-btc";

function candidate(
  id: string,
  ret30d: number,
  cluster: string,
  is_defensive = false,
): SatelliteCandidate {
  return { asset_id: id, ret30d, cluster, is_defensive };
}

describe("v2 allocator — TREND regime", () => {
  it("BTC anchor lands at ~50% in TREND with healthy satellites", () => {
    const sats = [
      candidate("tok-eth", 0.20, "L1"),
      candidate("tok-sol", 0.15, "L1"),
      candidate("tok-bnb", 0.10, "L1"),
      candidate("stk-nvda", 0.18, "semis"),
      candidate("stk-amd", 0.12, "semis"),
      candidate("rwa-xaut", 0.04, "RWA", true),
    ];
    const r = allocateV2({
      regime: "TREND",
      satellites: sats,
      btc_anchor_id: BTC,
    });
    expect(r.weights[BTC]).toBeCloseTo(0.50, 2);
    // Sum of satellites ≤ TREND target (cluster cap may leave it under-budget,
    // and the slack drops to cash rather than recreating concentration).
    const sat = Object.entries(r.weights)
      .filter(([k]) => k !== BTC)
      .reduce((s, [, v]) => s + v, 0);
    expect(sat).toBeGreaterThan(0.20); // not absurdly low
    expect(sat).toBeLessThanOrEqual(0.45 + 1e-6);
    // BTC + satellites + cash = 1
    const total = sat + r.weights[BTC] + r.cash_weight;
    expect(total).toBeCloseTo(1.0, 5);
  });

  it("BTC anchor stays inside [40%, 70%] band", () => {
    const sats = [candidate("tok-eth", 0.20, "L1")];
    const r = allocateV2({
      regime: "TREND",
      satellites: sats,
      btc_anchor_id: BTC,
    });
    expect(r.weights[BTC]).toBeGreaterThanOrEqual(BTC_MIN - 1e-6);
    expect(r.weights[BTC]).toBeLessThanOrEqual(BTC_MAX + 1e-6);
  });
});

describe("v2 allocator — DRAWDOWN regime keeps only defensives", () => {
  it("non-defensive satellites are dropped, only RWA/USDC retained", () => {
    const sats = [
      candidate("tok-eth", -0.05, "L1", false), // not defensive
      candidate("tok-sol", -0.10, "L1", false),
      candidate("rwa-xaut", 0.05, "RWA", true), // defensive
    ];
    const r = allocateV2({
      regime: "DRAWDOWN",
      satellites: sats,
      btc_anchor_id: BTC,
    });
    expect(r.weights[BTC]).toBeCloseTo(0.40, 2);
    // Only defensives present in satellites
    expect(r.weights["tok-eth"] ?? 0).toBe(0);
    expect(r.weights["tok-sol"] ?? 0).toBe(0);
    expect(r.weights["rwa-xaut"]).toBeGreaterThan(0);
    expect(r.cash_weight).toBeGreaterThan(0.40);
  });
});

describe("v2 allocator — concentration limits enforced", () => {
  it("no single satellite weight exceeds MAX_SINGLE_SATELLITE", () => {
    // One absurdly strong candidate — the cap should kick in.
    const sats = Array.from({ length: 4 }, (_, i) =>
      candidate(`asset-${i}`, 0.50, "single-cluster"),
    );
    const r = allocateV2({
      regime: "TREND",
      satellites: sats,
      btc_anchor_id: BTC,
    });
    for (const [k, w] of Object.entries(r.weights)) {
      if (k === BTC) continue;
      expect(w).toBeLessThanOrEqual(MAX_SINGLE_SATELLITE + 1e-6);
    }
  });

  it("no thematic cluster exceeds MAX_CLUSTER", () => {
    // Six high-momentum semis — without a cluster cap they'd dominate.
    const sats = [
      candidate("stk-nvda", 0.30, "semis"),
      candidate("stk-amd", 0.28, "semis"),
      candidate("stk-mu", 0.25, "semis"),
      candidate("stk-intc", 0.22, "semis"),
      candidate("stk-tsm", 0.20, "semis"),
      candidate("stk-asml", 0.18, "semis"),
      candidate("tok-eth", 0.15, "L1"),
      candidate("tok-sol", 0.13, "L1"),
    ];
    const r = allocateV2({
      regime: "TREND",
      satellites: sats,
      btc_anchor_id: BTC,
    });
    const clusterTotal = ["stk-nvda", "stk-amd", "stk-mu", "stk-intc", "stk-tsm", "stk-asml"]
      .map((k) => r.weights[k] ?? 0)
      .reduce((s, x) => s + x, 0);
    expect(clusterTotal).toBeLessThanOrEqual(MAX_CLUSTER + 1e-6);
  });

  it("positions below MIN_POSITION are pruned (no 1% noise positions)", () => {
    // Ten weak satellites — most should be below 3% after sizing
    const sats = Array.from({ length: 10 }, (_, i) =>
      candidate(`weak-${i}`, 0.05, `c-${i % 3}`),
    );
    const r = allocateV2({
      regime: "TREND",
      satellites: sats,
      btc_anchor_id: BTC,
    });
    for (const [k, w] of Object.entries(r.weights)) {
      if (k === BTC) continue;
      // Either zero or at least MIN_POSITION
      expect(w === 0 || w >= MIN_POSITION - 1e-6).toBe(true);
    }
  });

  it("retains at most MAX_SATELLITES distinct satellite positions", () => {
    const sats = Array.from({ length: 20 }, (_, i) =>
      candidate(`a-${i}`, 0.20 + i * 0.01, `c-${i % 4}`),
    );
    const r = allocateV2({
      regime: "TREND",
      satellites: sats,
      btc_anchor_id: BTC,
    });
    const satCount = Object.entries(r.weights).filter(
      ([k, w]) => k !== BTC && w > 0,
    ).length;
    expect(satCount).toBeLessThanOrEqual(MAX_SATELLITES);
  });
});

describe("v2.1 allocator — TREND-regime concentration relaxation", () => {
  it("TREND raises per-asset cap to 10% (vs 8% in CHOP/DRAWDOWN)", () => {
    const sats = Array.from({ length: 5 }, (_, i) =>
      candidate(`asset-${i}`, 0.50, `c-${i}`),
    );
    const trend = allocateV2({ regime: "TREND", satellites: sats, btc_anchor_id: BTC });
    const chop = allocateV2({ regime: "CHOP", satellites: sats, btc_anchor_id: BTC });

    const trendMaxSat = Math.max(
      ...Object.entries(trend.weights)
        .filter(([k]) => k !== BTC)
        .map(([, w]) => w),
    );
    const chopMaxSat = Math.max(
      ...Object.entries(chop.weights)
        .filter(([k]) => k !== BTC)
        .map(([, w]) => w),
    );
    expect(trendMaxSat).toBeLessThanOrEqual(MAX_SINGLE_SATELLITE_TREND + 1e-6);
    expect(chopMaxSat).toBeLessThanOrEqual(MAX_SINGLE_SATELLITE + 1e-6);
    // TREND should produce at least one weight strictly above the CHOP cap
    expect(trendMaxSat).toBeGreaterThan(MAX_SINGLE_SATELLITE);
  });

  it("TREND raises per-cluster cap to 18% (vs 15% in CHOP)", () => {
    const sats = [
      candidate("a1", 0.30, "X"),
      candidate("a2", 0.28, "X"),
      candidate("a3", 0.25, "X"),
      candidate("a4", 0.22, "X"),
    ];
    const trend = allocateV2({ regime: "TREND", satellites: sats, btc_anchor_id: BTC });
    const chop = allocateV2({ regime: "CHOP", satellites: sats, btc_anchor_id: BTC });

    const trendCluster = ["a1", "a2", "a3", "a4"]
      .map((k) => trend.weights[k] ?? 0)
      .reduce((s, x) => s + x, 0);
    const chopCluster = ["a1", "a2", "a3", "a4"]
      .map((k) => chop.weights[k] ?? 0)
      .reduce((s, x) => s + x, 0);

    expect(trendCluster).toBeLessThanOrEqual(MAX_CLUSTER_TREND + 1e-6);
    expect(chopCluster).toBeLessThanOrEqual(MAX_CLUSTER + 1e-6);
    expect(trendCluster).toBeGreaterThan(MAX_CLUSTER);
  });

  it("DRAWDOWN keeps original 8%/15% caps unchanged", () => {
    const sats = [
      candidate("rwa-xaut", 0.10, "RWA", true),
      candidate("rwa-paxg", 0.08, "RWA", true),
    ];
    const r = allocateV2({ regime: "DRAWDOWN", satellites: sats, btc_anchor_id: BTC });
    for (const [k, w] of Object.entries(r.weights)) {
      if (k === BTC) continue;
      expect(w).toBeLessThanOrEqual(MAX_SINGLE_SATELLITE + 1e-6);
    }
  });
});

describe("v2 allocator — weight sums to 1 with cash", () => {
  it("weights + cash always sum to ~1.0", () => {
    const sats = [
      candidate("tok-eth", 0.15, "L1"),
      candidate("tok-sol", 0.10, "L1"),
      candidate("rwa-xaut", 0.04, "RWA", true),
    ];
    for (const regime of ["TREND", "CHOP", "DRAWDOWN"] as const) {
      const r = allocateV2({
        regime,
        satellites: sats,
        btc_anchor_id: BTC,
      });
      const total = Object.values(r.weights).reduce((s, x) => s + x, 0) + r.cash_weight;
      expect(total).toBeCloseTo(1.0, 5);
    }
  });
});
