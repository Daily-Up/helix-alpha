import { describe, expect, it } from "vitest";
import {
  computeLifecycle,
  shouldExpireSignal,
} from "@/lib/pipeline/lifecycle";

describe("Bug class 3 — stale signals persist past their reaction window", () => {
  describe("computeLifecycle (deterministic from subtype)", () => {
    it("etf_flow_reaction is treated as slow-burn for corroboration (8h, regression bug A)", () => {
      // ETF flow data ships once per day — a single-source single-day
      // print needs the longer 8h window, not the default 4h, to avoid
      // dismissing legitimate flow news before the next outlet picks it up.
      const generated = 1_700_000_000_000;
      const r = computeLifecycle({
        subtype: "etf_flow_reaction",
        generated_at: generated,
        source_tier: 2,
      });
      expect(r.corroboration_deadline).not.toBeNull();
      expect(r.corroboration_deadline! - generated).toBe(8 * 3600 * 1000);
    });

    it("transient_operational sets short expiresAt (4h)", () => {
      const generated = 1_700_000_000_000;
      const r = computeLifecycle({
        subtype: "transient_operational",
        generated_at: generated,
        source_tier: 2,
      });
      expect(r.expires_at - generated).toBeLessThanOrEqual(
        4 * 3600 * 1000 + 1000,
      );
    });

    it("regulatory_statement sets multi-day expiresAt", () => {
      const generated = 1_700_000_000_000;
      const r = computeLifecycle({
        subtype: "regulatory_statement",
        generated_at: generated,
        source_tier: 1,
      });
      expect(r.expires_at - generated).toBeGreaterThanOrEqual(
        3 * 24 * 3600 * 1000,
      );
    });

    it("single-source (tier 2/3) sets a corroboration_deadline", () => {
      const r = computeLifecycle({
        subtype: "treasury_action",
        generated_at: Date.now(),
        source_tier: 2,
      });
      expect(r.corroboration_deadline).not.toBeNull();
    });

    it("tier-1 source has NO corroboration_deadline (Bloomberg = enough)", () => {
      const r = computeLifecycle({
        subtype: "treasury_action",
        generated_at: Date.now(),
        source_tier: 1,
      });
      expect(r.corroboration_deadline).toBeNull();
    });
  });

  describe("shouldExpireSignal", () => {
    const now = Date.now();
    it("expires when past expires_at", () => {
      const r = shouldExpireSignal({
        status: "pending",
        expires_at: now - 1000,
        corroboration_deadline: null,
        corroboration_count_at_check: 0,
      });
      expect(r.expire).toBe(true);
      expect(r.reason).toBe("stale_unexecuted");
    });

    it("expires when corroboration_deadline passed and still 0 sources", () => {
      const r = shouldExpireSignal({
        status: "pending",
        expires_at: now + 24 * 3600 * 1000,
        corroboration_deadline: now - 1000,
        corroboration_count_at_check: 0,
      });
      expect(r.expire).toBe(true);
      expect(r.reason).toBe("uncorroborated");
    });

    it("does NOT expire when corroboration_deadline passed but corroborated", () => {
      const r = shouldExpireSignal({
        status: "pending",
        expires_at: now + 24 * 3600 * 1000,
        corroboration_deadline: now - 1000,
        corroboration_count_at_check: 2,
      });
      expect(r.expire).toBe(false);
    });

    it("does NOT expire when within both windows", () => {
      const r = shouldExpireSignal({
        status: "pending",
        expires_at: now + 1000,
        corroboration_deadline: null,
        corroboration_count_at_check: 0,
      });
      expect(r.expire).toBe(false);
    });

    it("never expires non-pending signals", () => {
      const r = shouldExpireSignal({
        status: "executed",
        expires_at: now - 1_000_000,
        corroboration_deadline: null,
        corroboration_count_at_check: 0,
      });
      expect(r.expire).toBe(false);
    });
  });
});
