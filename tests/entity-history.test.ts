import { describe, expect, it } from "vitest";
import {
  deriveEventChainId,
  adjustConvictionForHistory,
} from "@/lib/pipeline/entity-history";

describe("Bug class 4 — entity-history awareness via event_chain_id", () => {
  describe("deriveEventChainId", () => {
    it("same actor + same affected entities + same week → same chain id", () => {
      const a = deriveEventChainId({
        primary_asset_id: "tok-arb",
        affected_asset_ids: ["tok-arb", "tok-aave"],
        event_type: "governance",
        release_time: new Date("2026-05-08T10:00:00Z").getTime(),
      });
      const b = deriveEventChainId({
        primary_asset_id: "tok-arb",
        affected_asset_ids: ["tok-aave", "tok-arb"], // different order
        event_type: "governance",
        release_time: new Date("2026-05-08T22:00:00Z").getTime(),
      });
      expect(a).toBe(b);
    });

    it("different primary asset → different chain id", () => {
      const a = deriveEventChainId({
        primary_asset_id: "tok-arb",
        affected_asset_ids: ["tok-arb"],
        event_type: "governance",
        release_time: Date.now(),
      });
      const b = deriveEventChainId({
        primary_asset_id: "tok-aave",
        affected_asset_ids: ["tok-aave"],
        event_type: "governance",
        release_time: Date.now(),
      });
      expect(a).not.toBe(b);
    });

    it("different event_type → different chain id", () => {
      const t = Date.now();
      const a = deriveEventChainId({
        primary_asset_id: "tok-arb",
        affected_asset_ids: ["tok-arb"],
        event_type: "governance",
        release_time: t,
      });
      const b = deriveEventChainId({
        primary_asset_id: "tok-arb",
        affected_asset_ids: ["tok-arb"],
        event_type: "exploit",
        release_time: t,
      });
      expect(a).not.toBe(b);
    });

    it("same chain spans the week (3-day temporal bucket)", () => {
      const monday = new Date("2026-05-04T10:00:00Z").getTime();
      const wednesday = new Date("2026-05-06T10:00:00Z").getTime();
      const sunday = new Date("2026-05-10T10:00:00Z").getTime();
      const a = deriveEventChainId({
        primary_asset_id: "tok-arb",
        affected_asset_ids: ["tok-arb"],
        event_type: "governance",
        release_time: monday,
      });
      const b = deriveEventChainId({
        primary_asset_id: "tok-arb",
        affected_asset_ids: ["tok-arb"],
        event_type: "governance",
        release_time: wednesday,
      });
      const c = deriveEventChainId({
        primary_asset_id: "tok-arb",
        affected_asset_ids: ["tok-arb"],
        event_type: "governance",
        release_time: sunday,
      });
      // All in same week → same chain.
      expect(a).toBe(b);
      expect(b).toBe(c);
    });
  });

  describe("adjustConvictionForHistory", () => {
    it("recent CONTRADICTORY signal halves the contradiction's conviction effect", () => {
      // New: WLFI LONG 0.65 (tech_update). History: WLFI SHORT 0.7 (regulatory) 1d ago.
      const r = adjustConvictionForHistory({
        new_direction: "long",
        new_conviction: 0.65,
        primary_asset_id: "tok-wlfi",
        history: [
          {
            asset_id: "tok-wlfi",
            direction: "short",
            conviction: 0.7,
            fired_at: Date.now() - 24 * 3600 * 1000,
            event_chain_id: "x",
          },
        ],
      });
      expect(r.adjusted_conviction).toBeLessThan(0.65);
      expect(r.reason).toMatch(/contradict/i);
    });

    it("same-direction recent signal does NOT downgrade", () => {
      const r = adjustConvictionForHistory({
        new_direction: "long",
        new_conviction: 0.6,
        primary_asset_id: "tok-arb",
        history: [
          {
            asset_id: "tok-arb",
            direction: "long",
            conviction: 0.7,
            fired_at: Date.now() - 12 * 3600 * 1000,
            event_chain_id: "y",
          },
        ],
      });
      expect(r.adjusted_conviction).toBeCloseTo(0.6, 5);
    });

    it("old (>7d) contradictory signal does NOT downgrade", () => {
      const r = adjustConvictionForHistory({
        new_direction: "long",
        new_conviction: 0.6,
        primary_asset_id: "tok-arb",
        history: [
          {
            asset_id: "tok-arb",
            direction: "short",
            conviction: 0.7,
            fired_at: Date.now() - 30 * 24 * 3600 * 1000, // 30 days ago
            event_chain_id: "z",
          },
        ],
      });
      expect(r.adjusted_conviction).toBeCloseTo(0.6, 5);
    });

    it("event_chain match flags chainContinuation", () => {
      const r = adjustConvictionForHistory({
        new_direction: "long",
        new_conviction: 0.6,
        primary_asset_id: "tok-arb",
        new_event_chain_id: "ARB_GOV_W19",
        history: [
          {
            asset_id: "tok-arb",
            direction: "short",
            conviction: 0.6,
            fired_at: Date.now() - 24 * 3600 * 1000,
            event_chain_id: "ARB_GOV_W19", // same chain — Kelp saga
          },
        ],
      });
      expect(r.is_chain_continuation).toBe(true);
    });
  });
});
