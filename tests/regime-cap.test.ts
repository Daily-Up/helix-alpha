/**
 * Tests for the regime cap — the pipeline check that downgrades AUTO
 * LONGs into counter-trend tape.
 *
 * The mid-flight choice that's easy to break is *which* asset's regime
 * gets read. ETH signals must read ETH; SOL signals must read SOL;
 * tokens/stocks not directly tracked must fall back to BTC; non-crypto
 * (macro, RWA, ETF) must not be regime-checked at all.
 *
 * We stub out getRegime so the test is hermetic and doesn't need a
 * populated historical_klines_hourly table.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const calls: Array<{ symbol: string }> = [];

vi.mock("@/lib/regime/classifier", () => ({
  getRegime: vi.fn(async (symbol: string) => {
    calls.push({ symbol });
    // Return a uniformly-down regime so the cap fires on LONGs.
    return {
      symbol,
      ts_ms: Date.now(),
      close: 1000,
      trend: "down",
      drawdown_pct: -15,
      vol_pct: 50,
      rsi_14: 35,
      days_since_ath: 40,
      return_30d_pct: -12,
      return_90d_pct: -20,
    };
  }),
  isStressRegime: vi.fn(() => true),
  getLatestBtcClose: vi.fn(async () => 50000),
}));

import { capTierForRegime } from "@/lib/pipeline/regime-cap";

describe("capTierForRegime — symbol routing", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("BTC signal reads BTC regime", async () => {
    await capTierForRegime({
      direction: "long",
      asset_kind: "token",
      asset_symbol: "BTC",
      current_tier: "auto",
    });
    expect(calls).toEqual([{ symbol: "BTC" }]);
  });

  it("ETH signal reads ETH regime (NOT BTC proxy)", async () => {
    await capTierForRegime({
      direction: "long",
      asset_kind: "token",
      asset_symbol: "ETH",
      current_tier: "auto",
    });
    expect(calls).toEqual([{ symbol: "ETH" }]);
  });

  it("SOL signal reads SOL regime", async () => {
    await capTierForRegime({
      direction: "long",
      asset_kind: "token",
      asset_symbol: "SOL",
      current_tier: "auto",
    });
    expect(calls).toEqual([{ symbol: "SOL" }]);
  });

  it("LINK signal falls back to BTC proxy (not directly tracked)", async () => {
    await capTierForRegime({
      direction: "long",
      asset_kind: "token",
      asset_symbol: "LINK",
      current_tier: "auto",
    });
    expect(calls).toEqual([{ symbol: "BTC" }]);
  });

  it("MSTR (treasury) falls back to BTC proxy", async () => {
    await capTierForRegime({
      direction: "long",
      asset_kind: "treasury",
      asset_symbol: "MSTR",
      current_tier: "auto",
    });
    expect(calls).toEqual([{ symbol: "BTC" }]);
  });

  it("Macro events skip regime check entirely", async () => {
    const r = await capTierForRegime({
      direction: "long",
      asset_kind: "macro",
      asset_symbol: "DXY",
      current_tier: "auto",
    });
    expect(calls).toEqual([]);
    expect(r.capped).toBe(false);
  });

  it("ETF aggregates skip regime check", async () => {
    const r = await capTierForRegime({
      direction: "long",
      asset_kind: "etf_aggregate",
      asset_symbol: "BTC-ETF-AGG",
      current_tier: "auto",
    });
    expect(calls).toEqual([]);
    expect(r.capped).toBe(false);
  });
});

describe("capTierForRegime — cap rules", () => {
  it("downgrades AUTO LONG into a down/oversold regime to REVIEW", async () => {
    const r = await capTierForRegime({
      direction: "long",
      asset_kind: "token",
      asset_symbol: "BTC",
      current_tier: "auto",
    });
    expect(r.capped).toBe(true);
    expect(r.tier).toBe("review");
    expect(r.reason).toMatch(/counter-trend/i);
  });

  it("does not cap REVIEW signals (manual reviewer can overrule)", async () => {
    const r = await capTierForRegime({
      direction: "long",
      asset_kind: "token",
      asset_symbol: "BTC",
      current_tier: "review",
    });
    expect(r.capped).toBe(false);
    expect(r.tier).toBe("review");
  });

  it("never cap INFO signals (already minimum)", async () => {
    const r = await capTierForRegime({
      direction: "long",
      asset_kind: "token",
      asset_symbol: "BTC",
      current_tier: "info",
    });
    expect(r.capped).toBe(false);
    expect(r.tier).toBe("info");
  });
});
