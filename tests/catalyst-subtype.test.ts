import { describe, expect, it } from "vitest";
import {
  inferCatalystSubtype,
  riskProfileForSubtype,
  capForFundingMagnitude,
} from "@/lib/pipeline/catalyst-subtype";

describe("Bug class 2 — catalyst subtype taxonomy", () => {
  describe("inferCatalystSubtype", () => {
    it("AWS outage → transient_operational (hours horizon)", () => {
      const r = inferCatalystSubtype("security", {
        title: "Coinbase outage extends past 5 hours due to AWS issues",
        sentiment: "negative",
      });
      expect(r).toBe("transient_operational");
    });

    it("whale large transfer → whale_flow", () => {
      const r = inferCatalystSubtype("other", {
        title: "Whale moved $180M ETH to Binance",
        sentiment: "negative",
      });
      expect(r).toBe("whale_flow");
    });

    it("Q1 earnings → earnings_reaction", () => {
      const r = inferCatalystSubtype("earnings", {
        title: "Coinbase missed Q1 revenue estimates",
        sentiment: "negative",
      });
      expect(r).toBe("earnings_reaction");
    });

    it("SEC chair statement → regulatory_statement (3-7d)", () => {
      const r = inferCatalystSubtype("regulatory", {
        title: "SEC chairman Atkins says crypto era has come",
        sentiment: "positive",
      });
      expect(r).toBe("regulatory_statement");
    });

    it("Senate Banking markup → legislative_progress", () => {
      const r = inferCatalystSubtype("regulatory", {
        title:
          "Senate Banking Committee preparing markup of Clarity Act this week",
        sentiment: "positive",
      });
      expect(r).toBe("legislative_progress");
    });

    it("CPI print → macro_print", () => {
      const r = inferCatalystSubtype("macro", {
        title: "CPI (MoM) prints 0.9% vs 1.0% forecast",
        sentiment: "positive",
      });
      expect(r).toBe("macro_print");
    });

    it("oil tanker attack → macro_geopolitical", () => {
      const r = inferCatalystSubtype("macro", {
        title:
          "U.S. military attacks several oil tankers attempting to break blockade",
        sentiment: "negative",
      });
      expect(r).toBe("macro_geopolitical");
    });

    it("hack confirmed → exploit_disclosure", () => {
      const r = inferCatalystSubtype("exploit", {
        title: "TrustedVolumes drained for $6.5M in flash loan attack",
        sentiment: "negative",
      });
      expect(r).toBe("exploit_disclosure");
    });

    it("vulnerability not yet exploited → security_disclosure", () => {
      const r = inferCatalystSubtype("security", {
        title: "LayerZero default library contract vulnerability — $178M at risk",
        sentiment: "negative",
      });
      expect(r).toBe("security_disclosure");
    });

    it("DAO vote → governance_vote", () => {
      const r = inferCatalystSubtype("governance", {
        title: "Mantle DAO approves $68M emergency support package",
        sentiment: "positive",
      });
      expect(r).toBe("governance_vote");
    });

    it("MSTR BTC accumulation → treasury_action", () => {
      const r = inferCatalystSubtype("treasury", {
        title: "Strategy adds 145,834 BTC to its treasury",
        sentiment: "positive",
      });
      expect(r).toBe("treasury_action");
    });

    it("partnership integration → partnership_announcement", () => {
      const r = inferCatalystSubtype("partnership", {
        title: "Aptos × NETSTARS Japan QR payment integration",
        sentiment: "positive",
      });
      expect(r).toBe("partnership_announcement");
    });

    it("VC funding round → fundraising_announcement", () => {
      const r = inferCatalystSubtype("fundraising", {
        title: "Balcony completes $12.7M seed round",
        sentiment: "positive",
      });
      expect(r).toBe("fundraising_announcement");
    });

    // ── Bug class A: ETF flow event_type previously fell through to
    //                 `other` because the inferer had no case for it.
    //                 An ETF flow has a distinct decay profile (~2d, daily
    //                 print rhythm) and shouldn't share a horizon with
    //                 unknown catalysts.
    it("ETF flow event → etf_flow_reaction (regression: bug class A)", () => {
      const r = inferCatalystSubtype("etf_flow", {
        title:
          "Fidelity's $BTC ETF led $277M in total outflows Thursday, snapping a 5-day streak",
        sentiment: "negative",
      });
      expect(r).toBe("etf_flow_reaction");
    });
    it("ETF inflow event → etf_flow_reaction", () => {
      const r = inferCatalystSubtype("etf_flow", {
        title: "BlackRock's IBIT records $1.4B daily inflow, all-time high",
        sentiment: "positive",
      });
      expect(r).toBe("etf_flow_reaction");
    });

    // ── Bug class B: whale_flow regex previously only caught the literal
    //                 word "whale", "large transfer/deposit/withdraw", or
    //                 "moved $Xm". Real coverage uses many more phrasings,
    //                 most commonly "deposited X into Binance" and
    //                 "$X outflow from spot exchanges". Without these the
    //                 sub-type fell to event_type defaults (treasury_action,
    //                 other) and signals got the wrong decay window.
    it("'deposited 108k ETH into Binance' → whale_flow (regression: bug class B)", () => {
      const r = inferCatalystSubtype("treasury", {
        title:
          "Garrett Jin deposited another 108,169 $ETH ($250.17M) into Binance in the past hour",
        sentiment: "negative",
      });
      expect(r).toBe("whale_flow");
    });
    it("'$115M XRP outflow from spot exchanges' → whale_flow", () => {
      const r = inferCatalystSubtype("other", {
        title: "$115 million XRP outflow from spot exchanges as demand increases",
        sentiment: "positive",
      });
      expect(r).toBe("whale_flow");
    });
    it("'$80M USDC withdrawn from Coinbase' → whale_flow", () => {
      const r = inferCatalystSubtype("other", {
        title: "$80M USDC withdrawn from Coinbase pro in past hour",
        sentiment: "neutral",
      });
      expect(r).toBe("whale_flow");
    });
    it("Generic 'transfer was made' (no size, no exchange) → NOT whale_flow", () => {
      // Negative test: the regex must not over-fire on generic verb usage.
      const r = inferCatalystSubtype("other", {
        title: "Coinbase enables transfers for new wallets",
        sentiment: "neutral",
      });
      expect(r).not.toBe("whale_flow");
    });
  });

  describe("riskProfileForSubtype — decay-aware horizons", () => {
    it("transient_operational has hours-scale horizon", () => {
      const r = riskProfileForSubtype("transient_operational", null);
      expect(r.horizon_ms).toBeLessThanOrEqual(6 * 3600 * 1000);
    });

    it("regulatory_statement has 3-7d horizon", () => {
      const r = riskProfileForSubtype("regulatory_statement", null);
      expect(r.horizon_ms).toBeGreaterThanOrEqual(3 * 24 * 3600 * 1000);
    });

    it("exploit_disclosure has tight horizon (1-4h)", () => {
      const r = riskProfileForSubtype("exploit_disclosure", null);
      expect(r.horizon_ms).toBeLessThanOrEqual(4 * 3600 * 1000);
    });

    it("etf_flow_reaction has 1-2d horizon (regression: bug class A)", () => {
      const r = riskProfileForSubtype("etf_flow_reaction", null);
      expect(r.horizon_ms).toBeGreaterThanOrEqual(24 * 3600 * 1000);
      expect(r.horizon_ms).toBeLessThanOrEqual(3 * 24 * 3600 * 1000);
    });

    it("whale_flow has hours-scale horizon (regression: bug class B)", () => {
      // Confirms that catching "deposited X into Binance" via the new
      // whale_flow patterns also routes the signal to the right decay
      // profile (8h), not the 3d treasury_action it used to inherit.
      const r = riskProfileForSubtype("whale_flow", null);
      expect(r.horizon_ms).toBeLessThanOrEqual(12 * 3600 * 1000);
    });

    it("vol-scales targets when 30d vol provided", () => {
      // High vol asset (1.0 = 100% annualized) → wider stops/targets
      const high = riskProfileForSubtype("regulatory_statement", 1.0);
      const low = riskProfileForSubtype("regulatory_statement", 0.2);
      expect(high.target_pct).toBeGreaterThan(low.target_pct);
      expect(high.stop_pct).toBeGreaterThan(low.stop_pct);
    });
  });

  describe("capForFundingMagnitude — cap small VC rounds", () => {
    it("$12M seed on a $5B-cap chain (0.24%) gets capped to INFO", () => {
      const t = capForFundingMagnitude("review", {
        round_size_usd: 12_000_000,
        market_cap_usd: 5_000_000_000,
      });
      expect(t).toBe("info");
    });
    it("$100M Series B on a $1B chain (10%) keeps tier", () => {
      const t = capForFundingMagnitude("review", {
        round_size_usd: 100_000_000,
        market_cap_usd: 1_000_000_000,
      });
      expect(t).toBe("review");
    });
    it("missing market_cap → no cap (can't decide)", () => {
      const t = capForFundingMagnitude("auto", {
        round_size_usd: 12_000_000,
        market_cap_usd: null,
      });
      expect(t).toBe("auto");
    });
  });
});
