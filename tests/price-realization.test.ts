/**
 * Dimension 2 regression — price-already-moved check.
 *
 * For every signal, compute realized_fraction = realized_move /
 * expected_move (signed by predicted direction). Then:
 *
 *   realized_fraction > 1.0  → drop (`move_exhausted`)
 *   realized_fraction > 0.6  → cap to INFO (`move_largely_realized`)
 *   realized_fraction < -0.3 → drop (`market_disagrees`)
 *   else                     → proceed
 *
 * The check is two pieces:
 *   - `computeRealizedFraction()` is the pure function
 *   - the pre-save gate enforces the thresholds (fallback assertion)
 */

import { describe, expect, it } from "vitest";
import {
  computeRealizedFraction,
  applyRealizedMoveCap,
} from "@/lib/pipeline/price-realization";
import {
  checkSignalInvariants,
  type PreSaveSignal,
} from "@/lib/pipeline/invariants";

describe("Dimension 2 — price-already-moved", () => {
  describe("computeRealizedFraction (pure)", () => {
    it("LONG: price up 4%, expected +5% → realized_fraction = 0.8", () => {
      const f = computeRealizedFraction({
        direction: "long",
        catalyst_price: 100,
        current_price: 104,
        expected_move_pct: 5,
      });
      expect(f).toBeCloseTo(0.8, 2);
    });

    it("SHORT: price down 6%, expected -5% → realized_fraction = 1.2 (exhausted)", () => {
      const f = computeRealizedFraction({
        direction: "short",
        catalyst_price: 100,
        current_price: 94,
        expected_move_pct: 5,
      });
      expect(f).toBeCloseTo(1.2, 2);
    });

    it("LONG: price moved against us by 2% on +5% expected → realized_fraction = -0.4", () => {
      const f = computeRealizedFraction({
        direction: "long",
        catalyst_price: 100,
        current_price: 98,
        expected_move_pct: 5,
      });
      expect(f).toBeCloseTo(-0.4, 2);
    });

    it("returns null when expected_move_pct is 0 or negative (defensive)", () => {
      expect(
        computeRealizedFraction({
          direction: "long",
          catalyst_price: 100,
          current_price: 105,
          expected_move_pct: 0,
        }),
      ).toBeNull();
    });

    it("returns null when prices unavailable", () => {
      expect(
        computeRealizedFraction({
          direction: "long",
          catalyst_price: null,
          current_price: 105,
          expected_move_pct: 5,
        }),
      ).toBeNull();
    });
  });

  describe("applyRealizedMoveCap (verdict)", () => {
    it("realized_fraction = 0.8 → cap to INFO with move_largely_realized", () => {
      const v = applyRealizedMoveCap({ realized_fraction: 0.8, tier: "review" });
      expect(v.verdict).toBe("downgrade");
      expect(v.tier).toBe("info");
      expect(v.reason).toBe("move_largely_realized");
    });

    it("realized_fraction = 1.2 → drop with move_exhausted", () => {
      const v = applyRealizedMoveCap({ realized_fraction: 1.2, tier: "auto" });
      expect(v.verdict).toBe("drop");
      expect(v.reason).toBe("move_exhausted");
    });

    it("realized_fraction = -0.4 → drop with market_disagrees", () => {
      const v = applyRealizedMoveCap({ realized_fraction: -0.4, tier: "auto" });
      expect(v.verdict).toBe("drop");
      expect(v.reason).toBe("market_disagrees");
    });

    it("realized_fraction = 0.5 → proceed", () => {
      const v = applyRealizedMoveCap({ realized_fraction: 0.5, tier: "review" });
      expect(v.verdict).toBe("proceed");
      expect(v.tier).toBe("review");
    });

    it("realized_fraction = null → proceed (price feed unavailable)", () => {
      const v = applyRealizedMoveCap({ realized_fraction: null, tier: "review" });
      expect(v.verdict).toBe("proceed");
    });
  });

  describe("Pre-save gate enforcement (fallback assertion)", () => {
    const baseSignal: PreSaveSignal = {
      asset_id: "tok-btc",
      asset_kind: "token",
      asset_symbol: "BTC",
      direction: "long",
      tier: "review",
      confidence: 0.65,
      reasoning: "test",
      expected_horizon: "3d",
      suggested_stop_pct: 4,
      suggested_target_pct: 6,
      asset_relevance: 1.0,
      catalyst_subtype: "etf_flow_reaction",
      promotional_score: 0,
      source_tier: 2,
      expires_at: Date.now() + 3 * 24 * 3600 * 1000,
      corroboration_deadline: null,
      event_chain_id: null,
      is_digest: false,
      title_validation_ok: true,
      base_rate: null,
      mechanism_length: null,
      counterfactual_strength: null,
    };

    it("realized 0.8 + tier=review → BLOCKED with move_largely_realized (upstream forgot to cap)", () => {
      const r = checkSignalInvariants({ ...baseSignal, realized_fraction: 0.8 });
      expect(r.ok).toBe(false);
      expect(r.violations.some((v) => v.rule === "move_largely_realized")).toBe(
        true,
      );
    });

    it("realized 0.8 + tier=info → ok (downgrade was applied)", () => {
      const r = checkSignalInvariants({
        ...baseSignal,
        tier: "info",
        realized_fraction: 0.8,
      });
      expect(
        r.violations.find((v) => v.rule === "move_largely_realized"),
      ).toBeUndefined();
    });

    it("realized 1.2 → BLOCKED with move_exhausted", () => {
      const r = checkSignalInvariants({ ...baseSignal, realized_fraction: 1.2 });
      expect(r.ok).toBe(false);
      expect(r.violations.some((v) => v.rule === "move_exhausted")).toBe(true);
    });

    it("realized -0.4 → BLOCKED with market_disagrees", () => {
      const r = checkSignalInvariants({
        ...baseSignal,
        realized_fraction: -0.4,
      });
      expect(r.ok).toBe(false);
      expect(r.violations.some((v) => v.rule === "market_disagrees")).toBe(
        true,
      );
    });

    it("realized null → no rule fires (price feed unavailable, document as gap)", () => {
      const r = checkSignalInvariants({
        ...baseSignal,
        realized_fraction: null,
      });
      expect(
        r.violations.find((v) => v.rule === "move_largely_realized"),
      ).toBeUndefined();
      expect(
        r.violations.find((v) => v.rule === "move_exhausted"),
      ).toBeUndefined();
      expect(
        r.violations.find((v) => v.rule === "market_disagrees"),
      ).toBeUndefined();
    });
  });
});
