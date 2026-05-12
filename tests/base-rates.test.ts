/**
 * Dimension 5 regression test — base rates table drives target/stop/horizon
 * for catalyst×asset-class combinations, replacing LLM-intuited values that
 * gave "+18% target on AMZN earnings" sized like a +18% on BTC.
 */

import { describe, expect, it } from "vitest";
import {
  classifyAssetClass,
  getBaseRate,
  riskFromBaseRate,
  shouldCapConvictionFromBaseRate,
  exceedsBaseRateTarget,
} from "@/lib/pipeline/base-rates";

describe("Dimension 5 — base rate table", () => {
  describe("classifyAssetClass — asset → class mapping", () => {
    it("BTC token → large_cap_crypto", () => {
      expect(classifyAssetClass({ kind: "token", symbol: "BTC" })).toBe(
        "large_cap_crypto",
      );
    });
    it("ETH token → large_cap_crypto", () => {
      expect(classifyAssetClass({ kind: "token", symbol: "ETH" })).toBe(
        "large_cap_crypto",
      );
    });
    it("SOL token → mid_cap_crypto", () => {
      expect(classifyAssetClass({ kind: "token", symbol: "SOL" })).toBe(
        "mid_cap_crypto",
      );
    });
    it("PENGU token (meme alt) → small_cap_crypto", () => {
      expect(classifyAssetClass({ kind: "token", symbol: "PENGU" })).toBe(
        "small_cap_crypto",
      );
    });
    it("COIN stock → crypto_adjacent_equity", () => {
      expect(classifyAssetClass({ kind: "stock", symbol: "COIN" })).toBe(
        "crypto_adjacent_equity",
      );
    });
    it("MSTR treasury → crypto_adjacent_equity", () => {
      expect(classifyAssetClass({ kind: "treasury", symbol: "MSTR" })).toBe(
        "crypto_adjacent_equity",
      );
    });
    it("AMZN stock → broad_equity", () => {
      expect(classifyAssetClass({ kind: "stock", symbol: "AMZN" })).toBe(
        "broad_equity",
      );
    });
    it("CL (crude oil) → commodity", () => {
      expect(classifyAssetClass({ kind: "index", symbol: "CL" })).toBe(
        "commodity",
      );
    });
    it("US500 → index", () => {
      expect(classifyAssetClass({ kind: "index", symbol: "US500" })).toBe(
        "index",
      );
    });
  });

  describe("getBaseRate — lookup", () => {
    it("returns an entry for earnings_reaction × crypto_adjacent_equity", () => {
      const br = getBaseRate("earnings_reaction", "crypto_adjacent_equity");
      expect(br).not.toBeNull();
      expect(br!.mean_move_pct).toBeGreaterThan(0);
      expect(br!.stdev_move_pct).toBeGreaterThan(0);
      expect(br!.horizon_hours).toBeGreaterThan(0);
    });
    it("returns null for an uncalibrated combination (transient × commodity)", () => {
      const br = getBaseRate("transient_operational", "commodity");
      expect(br).toBeNull();
    });
  });

  describe("riskFromBaseRate — replaces +18% defaults with calibrated bands", () => {
    it("earnings_reaction × COIN: target between 4-10% (NOT +18%)", () => {
      const br = getBaseRate("earnings_reaction", "crypto_adjacent_equity")!;
      const r = riskFromBaseRate(br);
      expect(r.target_pct).toBeGreaterThanOrEqual(4);
      expect(r.target_pct).toBeLessThanOrEqual(10);
      // Stop should be at ~1σ adverse, smaller than target.
      expect(r.stop_pct).toBeLessThan(r.target_pct);
    });

    it("whale_flow × ETH: horizon 4-12h (NOT 24h+)", () => {
      const br = getBaseRate("whale_flow", "large_cap_crypto")!;
      const r = riskFromBaseRate(br);
      expect(r.horizon_hours).toBeGreaterThanOrEqual(4);
      expect(r.horizon_hours).toBeLessThanOrEqual(12);
    });

    it("etf_flow_reaction × BTC: target between 2-6%", () => {
      const br = getBaseRate("etf_flow_reaction", "large_cap_crypto")!;
      const r = riskFromBaseRate(br);
      expect(r.target_pct).toBeGreaterThanOrEqual(2);
      expect(r.target_pct).toBeLessThanOrEqual(6);
    });

    it("stop_pct ≈ stdev (1σ adverse) — confirms 'stop = -1σ' rule", () => {
      const br = getBaseRate("earnings_reaction", "crypto_adjacent_equity")!;
      const r = riskFromBaseRate(br);
      expect(r.stop_pct).toBeCloseTo(br.stdev_move_pct, 1);
    });
  });

  describe("shouldCapConvictionFromBaseRate — small-mean buckets cap at 65", () => {
    it("base rate with mean < 2% caps conviction at 65", () => {
      const br = {
        mean_move_pct: 1.0,
        stdev_move_pct: 2.5,
        horizon_hours: 48,
        sample_size: 0,
        notes: "test",
      };
      const cap = shouldCapConvictionFromBaseRate(br);
      expect(cap.cap).toBe(true);
      expect(cap.ceiling).toBe(0.65);
    });
    it("base rate with mean >= 2% does not cap", () => {
      const br = {
        mean_move_pct: 4.0,
        stdev_move_pct: 5.0,
        horizon_hours: 48,
        sample_size: 0,
        notes: "test",
      };
      const cap = shouldCapConvictionFromBaseRate(br);
      expect(cap.cap).toBe(false);
    });
  });

  describe("exceedsBaseRateTarget — gate rule (target_exceeds_base_rate)", () => {
    it("target 25% on a base rate with mean+stdev=11% → exceeds (gate refuses)", () => {
      // 2× threshold = 22%, target 25% > 22% → flag
      const br = {
        mean_move_pct: 6,
        stdev_move_pct: 5,
        horizon_hours: 48,
        sample_size: 0,
        notes: "",
      };
      expect(exceedsBaseRateTarget(25, br)).toBe(true);
    });
    it("target 18% on a base rate with mean+stdev=11% → exceeds", () => {
      const br = {
        mean_move_pct: 6,
        stdev_move_pct: 5,
        horizon_hours: 48,
        sample_size: 0,
        notes: "",
      };
      expect(exceedsBaseRateTarget(23, br)).toBe(true);
    });
    it("target 10% on a base rate with mean+stdev=11% → ok", () => {
      const br = {
        mean_move_pct: 6,
        stdev_move_pct: 5,
        horizon_hours: 48,
        sample_size: 0,
        notes: "",
      };
      expect(exceedsBaseRateTarget(10, br)).toBe(false);
    });
  });
});
