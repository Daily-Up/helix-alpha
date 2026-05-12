import { describe, expect, it } from "vitest";
import {
  scoreAssetRelevance,
  routeAssets,
  isIndexConstituent,
} from "@/lib/pipeline/asset-router";

const BTC = { asset_id: "tok-btc", symbol: "BTC", kind: "token", tradable: true };
const ETH = { asset_id: "tok-eth", symbol: "ETH", kind: "token", tradable: true };
const COIN = { asset_id: "stk-coin", symbol: "COIN", kind: "stock", tradable: true };
const MSTR = { asset_id: "trs-mstr", symbol: "MSTR", kind: "treasury", tradable: true };
const NVDA = { asset_id: "stk-nvda", symbol: "NVDA", kind: "stock", tradable: true };
const ARB = { asset_id: "tok-arb", symbol: "ARB", kind: "token", tradable: true };
const AAVE = { asset_id: "tok-aave", symbol: "AAVE", kind: "token", tradable: true };
const MNT = { asset_id: "tok-mnt", symbol: "MNT", kind: "token", tradable: false };
const SSIMAG7 = {
  asset_id: "idx-ssimag7",
  symbol: "ssimag7",
  kind: "index",
  tradable: true,
};
const SSIDEFI = {
  asset_id: "idx-ssidefi",
  symbol: "ssidefi",
  kind: "index",
  tradable: true,
};
const USDT = { asset_id: "rwa-usdt", symbol: "USDT", kind: "rwa", tradable: true };

describe("Bug class 1 — asset router fires on wrong asset", () => {
  describe("isIndexConstituent (constituent membership table)", () => {
    it("MSTR is NOT a member of MAG7 (well-known constituent fact)", () => {
      // MAG7 = AAPL/MSFT/GOOGL/AMZN/META/NVDA/TSLA. MSTR is not one.
      expect(isIndexConstituent("idx-ssimag7", "trs-mstr")).toBe(false);
    });
    it("COIN is NOT a member of MAG7", () => {
      expect(isIndexConstituent("idx-ssimag7", "stk-coin")).toBe(false);
    });
    it("NVDA IS a member of MAG7", () => {
      expect(isIndexConstituent("idx-ssimag7", "stk-nvda")).toBe(true);
    });
    it("AAVE IS a member of ssidefi", () => {
      expect(isIndexConstituent("idx-ssidefi", "tok-aave")).toBe(true);
    });
    it("BTC is NOT a member of ssidefi", () => {
      expect(isIndexConstituent("idx-ssidefi", "tok-btc")).toBe(false);
    });
  });

  describe("scoreAssetRelevance", () => {
    it("subject named in title = 'subject'", () => {
      const r = scoreAssetRelevance({
        candidate: COIN,
        title: "Coinbase missed Q1 revenue estimates as crypto trading slides",
        affected_asset_ids: ["stk-coin"],
        event_type: "earnings",
      });
      expect(r.relevance).toBe("subject");
    });

    it("named in title but not subject = 'directly_affected'", () => {
      // IREN news mentioning NVIDIA as counterparty
      const r = scoreAssetRelevance({
        candidate: NVDA,
        title: "IREN reports Q3 results with $3.4B AI cloud contract from NVIDIA",
        affected_asset_ids: ["stk-iren", "stk-nvda"],
        event_type: "earnings",
      });
      // NVDA appears in title but the event is IREN's earnings.
      expect(["directly_affected", "incidentally_mentioned"]).toContain(
        r.relevance,
      );
      expect(r.relevance).not.toBe("subject");
    });

    it("incidental mention (in body only, generic context) = 'incidentally_mentioned'", () => {
      const r = scoreAssetRelevance({
        candidate: ARB,
        title:
          "LayerZero default library contract has critical vulnerability — $178M at risk",
        affected_asset_ids: ["tok-arb"], // classifier added it as proxy
        event_type: "security",
      });
      // ARB isn't named in the title; LayerZero is the subject.
      expect(r.relevance).not.toBe("subject");
    });

    it("BLOCKS basket-without-member: MAG7 on MSTR-specific catalyst", () => {
      const r = scoreAssetRelevance({
        candidate: SSIMAG7,
        title: "Strategy added 145,834 BTC to its treasury, JPMorgan reports",
        affected_asset_ids: ["trs-mstr", "tok-btc", "idx-ssimag7"],
        event_type: "treasury",
      });
      expect(r.relevance).toBe("basket_without_member");
      expect(r.score).toBe(0);
    });

    it("ALLOWS basket-with-member: ssidefi when AAVE is a constituent", () => {
      const r = scoreAssetRelevance({
        candidate: SSIDEFI,
        title:
          "Mantle DAO approves $68M emergency support package for Aave protocol",
        affected_asset_ids: ["tok-mnt", "tok-aave", "idx-ssidefi"],
        event_type: "governance",
      });
      // AAVE is in ssidefi's constituents, so basket_with_member is OK
      // but should NEVER beat the directly-named token.
      expect(r.relevance).toBe("basket_with_member");
      expect(r.score).toBe(0.5);
    });
  });

  describe("routeAssets", () => {
    it("MSTR-specific BTC treasury news routes to MSTR, NOT to MAG7", () => {
      const r = routeAssets({
        title:
          "Strategy added 145,834 BTC to its treasury, JPMorgan estimates $30B impact",
        candidates: [SSIMAG7, BTC, MSTR],
        affected_asset_ids: ["idx-ssimag7", "tok-btc", "trs-mstr"],
        event_type: "treasury",
      });
      expect(r.primary?.asset_id).toBe("trs-mstr");
      expect(r.rejected.find((x) => x.candidate.asset_id === "idx-ssimag7"))
        .toBeDefined();
    });

    it("Mantle DAO emergency package routes to AAVE, NOT to ssidefi", () => {
      const r = routeAssets({
        title:
          "Mantle (MNT) DAO approves $68M emergency support for Aave protocol",
        candidates: [MNT, AAVE, ETH, SSIDEFI],
        affected_asset_ids: ["tok-mnt", "tok-aave", "tok-eth", "idx-ssidefi"],
        event_type: "governance",
      });
      // MNT is not tradable, so AAVE wins.
      expect(r.primary?.asset_id).toBe("tok-aave");
    });

    it("Coinbase-specific catalyst does NOT route to MAG7 (COIN ∉ MAG7)", () => {
      const r = routeAssets({
        title: "Coinbase missed Q1 revenue estimates",
        candidates: [SSIMAG7, COIN],
        affected_asset_ids: ["idx-ssimag7", "stk-coin"],
        event_type: "earnings",
      });
      expect(r.primary?.asset_id).toBe("stk-coin");
      // ssimag7 should be rejected explicitly, not just deprioritized.
      const rejected = r.rejected.find(
        (x) => x.candidate.asset_id === "idx-ssimag7",
      );
      expect(rejected).toBeDefined();
    });

    it("LayerZero security vulnerability does NOT pick ARB (incidental)", () => {
      const r = routeAssets({
        title:
          "LayerZero default library contract has critical security vulnerability",
        candidates: [ARB], // classifier proxied to ARB only
        affected_asset_ids: ["tok-arb"],
        event_type: "security",
      });
      // ARB isn't the subject. The router should reject it.
      // (Exact handling: returns null primary, signal generator sees this
      //  and skips the event entirely.)
      expect(r.primary).toBeNull();
    });

    // ── Bug class E regression: a token/rwa/stock that wasn't named in
    //                              the title and isn't a major must score
    //                              `incidentally_mentioned` (0.3), NOT 0.5.
    //                              Fixed in signal-generator: it used to
    //                              fall back to a literal 0.5 placeholder
    //                              when the inline gate path picked an
    //                              asset different from the router's
    //                              primary, defeating the invariant gate's
    //                              `relevance >= 0.5` check.
    it(
      "USDT on Warren-Meta letter scores incidentally_mentioned (regression: bug class E)",
      () => {
        const r = scoreAssetRelevance({
          candidate: USDT,
          title:
            "Senator Warren Sends Letter to Zuckerberg, Demanding Meta Explain Its Stablecoin Integration Plans",
          affected_asset_ids: ["rwa-usdt"],
          event_type: "regulatory",
        });
        expect(r.relevance).toBe("incidentally_mentioned");
        expect(r.score).toBeLessThan(0.5);
      },
    );

    it("router returns null primary on Warren-Meta letter when only USDT is offered", () => {
      // Whole-pipeline regression: with USDT as the only candidate, the
      // router's "best score < 0.5" rule kicks in and returns null primary
      // — meaning the signal generator should drop the event entirely.
      const r = routeAssets({
        title:
          "Senator Warren Sends Letter to Zuckerberg, Demanding Meta Explain Its Stablecoin Integration Plans",
        candidates: [USDT],
        affected_asset_ids: ["rwa-usdt"],
        event_type: "regulatory",
      });
      expect(r.primary).toBeNull();
    });

    it("Macro events (Fed dovish) emit multi-asset output", () => {
      const r = routeAssets({
        title:
          "Federal Reserve Governor Milan signals interest rate cut in May",
        candidates: [BTC, ETH, COIN],
        affected_asset_ids: ["tok-btc", "tok-eth", "stk-coin"],
        event_type: "macro",
      });
      expect(r.primary).not.toBeNull();
      // Macro events should populate secondaries, not single-asset.
      expect(r.secondaries.length).toBeGreaterThanOrEqual(1);
    });
  });
});
