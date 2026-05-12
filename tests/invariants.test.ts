import { describe, expect, it } from "vitest";
import { checkSignalInvariants } from "@/lib/pipeline/invariants";

const baseSignal = {
  asset_id: "stk-coin",
  asset_kind: "stock",
  asset_symbol: "COIN",
  direction: "short" as const,
  tier: "review" as const,
  confidence: 0.7,
  reasoning:
    "Coinbase Q1 miss — fresh earnings catalyst.\n\nConviction breakdown.",
  expected_horizon: "3d",
  suggested_stop_pct: 6,
  suggested_target_pct: 9,
  // Pipeline metadata
  asset_relevance: 1.0,
  catalyst_subtype: "earnings_reaction" as const,
  promotional_score: 0.1,
  source_tier: 2 as const,
  expires_at: Date.now() + 3 * 24 * 3600 * 1000,
  corroboration_deadline: Date.now() + 4 * 3600 * 1000,
  event_chain_id: "abc",
  is_digest: false,
  title_validation_ok: true,
  // Dimensions 3/4/5: null on legacy rows is allowed (gate skips).
  base_rate: null,
  mechanism_length: null,
  counterfactual_strength: null,
};

describe("Pre-save invariant gate — last line of defense", () => {
  it("PASSES a clean signal", () => {
    const r = checkSignalInvariants(baseSignal);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("BLOCKS signals built from digest articles", () => {
    const r = checkSignalInvariants({ ...baseSignal, is_digest: true });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.rule === "digest_source")).toBe(true);
  });

  it("BLOCKS signals where title failed ingestion validation", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      title_validation_ok: false,
    });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.rule === "ingestion_title_invalid"))
      .toBe(true);
  });

  it("BLOCKS basket primary that lacks subject membership (relevance 0)", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      asset_kind: "index",
      asset_id: "idx-ssimag7",
      asset_relevance: 0.0, // basket_without_member
    });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.rule === "asset_basket_without_member"))
      .toBe(true);
  });

  it("BLOCKS signals with relevance below 0.5 as primary", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      asset_relevance: 0.3, // incidentally_mentioned
    });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.rule === "primary_below_relevance"))
      .toBe(true);
  });

  it("BLOCKS AUTO tier with promotional score >= 0.5 + non-tier-1 source", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      tier: "auto",
      promotional_score: 0.7,
      source_tier: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.rule === "auto_promotional_uncapped"))
      .toBe(true);
  });

  it("BLOCKS signal with expires_at <= fired_at-equivalent (zero-life signal)", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      expires_at: Date.now() - 1000,
    });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.rule === "expires_at_in_past")).toBe(
      true,
    );
  });

  it("BLOCKS missing required pipeline metadata", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      catalyst_subtype: undefined as never,
    });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.rule === "missing_subtype")).toBe(true);
  });

  it("BLOCKS confidence outside [0,1]", () => {
    expect(
      checkSignalInvariants({ ...baseSignal, confidence: 1.5 }).ok,
    ).toBe(false);
    expect(
      checkSignalInvariants({ ...baseSignal, confidence: -0.1 }).ok,
    ).toBe(false);
  });

  it("BLOCKS impossible risk parameters (stop or target <= 0)", () => {
    expect(
      checkSignalInvariants({ ...baseSignal, suggested_stop_pct: 0 }).ok,
    ).toBe(false);
    expect(
      checkSignalInvariants({ ...baseSignal, suggested_target_pct: -5 }).ok,
    ).toBe(false);
  });

  // ── Bug class F regression ──
  // Earnings = quarterly print. Tokens don't have earnings. The pre-save
  // gate must refuse a signal where catalyst_subtype='earnings_reaction'
  // fired on a non-stock/non-treasury primary.
  it(
    "BLOCKS earnings_reaction on a token primary (regression: bug class F)",
    () => {
      const r = checkSignalInvariants({
        ...baseSignal,
        asset_id: "tok-trump",
        asset_kind: "token",
        asset_symbol: "TRUMP",
        catalyst_subtype: "earnings_reaction",
      });
      expect(r.ok).toBe(false);
      expect(
        r.violations.some(
          (v) => v.rule === "earnings_reaction_on_non_corporate",
        ),
      ).toBe(true);
    },
  );

  it(
    "PASSES earnings_reaction on a treasury primary (MSTR is BOTH stock and treasury)",
    () => {
      const r = checkSignalInvariants({
        ...baseSignal,
        asset_id: "trs-mstr",
        asset_kind: "treasury",
        asset_symbol: "MSTR",
        catalyst_subtype: "earnings_reaction",
      });
      expect(r.ok).toBe(true);
    },
  );

  it("collects ALL violations, not just the first", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      is_digest: true,
      asset_relevance: 0.0,
      confidence: 2.0,
    });
    expect(r.violations.length).toBeGreaterThanOrEqual(3);
  });
});
