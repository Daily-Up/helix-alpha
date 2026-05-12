/**
 * Dimension 3+4 regression — mechanism length + counterfactual strength
 * conviction caps, enforced as a pure-function gate rule on the
 * ClassifiedEvent → Signal transformation.
 *
 * The caps are deterministic: they don't trust the LLM to self-apply
 * them. If the upstream classifier produces confidence inconsistent
 * with mechanism_length / counterfactual_strength, the pre-save gate
 * refuses the signal — forcing the upstream stage to be debugged
 * rather than masked.
 *
 * Caps:
 *   mechanism_length=1 → 1.0 (no cap)
 *   mechanism_length=2 → 0.85
 *   mechanism_length=3 → 0.70
 *   mechanism_length=4 → 0.55
 *
 *   counterfactual_strength=weak     → 1.0 (no cap)
 *   counterfactual_strength=moderate → 0.80
 *   counterfactual_strength=strong   → 0.60
 */

import { describe, expect, it } from "vitest";
import {
  checkSignalInvariants,
  type PreSaveSignal,
} from "@/lib/pipeline/invariants";

const baseSignal: PreSaveSignal = {
  asset_id: "tok-btc",
  asset_kind: "token",
  asset_symbol: "BTC",
  direction: "long",
  tier: "review",
  confidence: 0.7,
  reasoning: "Test signal",
  expected_horizon: "3d",
  suggested_stop_pct: 4,
  suggested_target_pct: 8,
  asset_relevance: 1.0,
  catalyst_subtype: "treasury_action",
  promotional_score: 0.0,
  source_tier: 2,
  expires_at: Date.now() + 3 * 24 * 3600 * 1000,
  corroboration_deadline: Date.now() + 4 * 3600 * 1000,
  event_chain_id: null,
  is_digest: false,
  title_validation_ok: true,
  base_rate: null,
  mechanism_length: null,
  counterfactual_strength: null,
};

describe("Dimension 3 — mechanism length conviction cap", () => {
  it("mechanism_length=1 + conviction=0.95 → no violation (no cap)", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      tier: "auto",
      confidence: 0.95,
      mechanism_length: 1,
    });
    expect(
      r.violations.find((v) => v.rule === "mechanism_conviction_excess"),
    ).toBeUndefined();
  });

  it("mechanism_length=2 + conviction=0.86 → BLOCKED (cap is 0.85)", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      tier: "auto",
      confidence: 0.86,
      mechanism_length: 2,
    });
    expect(r.ok).toBe(false);
    expect(
      r.violations.some((v) => v.rule === "mechanism_conviction_excess"),
    ).toBe(true);
  });

  it("mechanism_length=2 + conviction=0.85 → ok (boundary inclusive)", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      tier: "auto",
      confidence: 0.85,
      mechanism_length: 2,
    });
    expect(
      r.violations.find((v) => v.rule === "mechanism_conviction_excess"),
    ).toBeUndefined();
  });

  it("mechanism_length=3 + conviction=0.71 → BLOCKED (cap is 0.70)", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      tier: "review",
      confidence: 0.71,
      mechanism_length: 3,
    });
    expect(r.ok).toBe(false);
    expect(
      r.violations.some((v) => v.rule === "mechanism_conviction_excess"),
    ).toBe(true);
  });

  // Synthetic ClassifiedEvent with mechanismLength=4 and conviction=80
  // (per task spec). Gate must refuse.
  it("mechanism_length=4 + conviction=0.80 → BLOCKED with mechanism_conviction_excess (regression: D4)", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      tier: "review",
      confidence: 0.80,
      mechanism_length: 4,
    });
    expect(r.ok).toBe(false);
    expect(
      r.violations.some((v) => v.rule === "mechanism_conviction_excess"),
    ).toBe(true);
    // Cap for length=4 is 0.55 — message references it.
    const v = r.violations.find(
      (v) => v.rule === "mechanism_conviction_excess",
    )!;
    expect(v.message).toContain("0.55");
  });

  it("mechanism_length=4 + conviction=0.55 → ok (at the cap)", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      tier: "info",
      confidence: 0.55,
      mechanism_length: 4,
    });
    expect(
      r.violations.find((v) => v.rule === "mechanism_conviction_excess"),
    ).toBeUndefined();
  });

  it("mechanism_length=null → no cap rule fires (legacy rows pass)", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      tier: "auto",
      confidence: 0.99,
      mechanism_length: null,
    });
    expect(
      r.violations.find((v) => v.rule === "mechanism_conviction_excess"),
    ).toBeUndefined();
  });
});

describe("Dimension 3 — counterfactual strength conviction cap", () => {
  it("counterfactual=weak + conviction=0.95 → no violation", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      tier: "auto",
      confidence: 0.95,
      counterfactual_strength: "weak",
    });
    expect(
      r.violations.find((v) => v.rule === "counterfactual_conviction_excess"),
    ).toBeUndefined();
  });

  it("counterfactual=moderate + conviction=0.81 → BLOCKED (cap is 0.80)", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      tier: "auto",
      confidence: 0.81,
      counterfactual_strength: "moderate",
    });
    expect(r.ok).toBe(false);
    expect(
      r.violations.some((v) => v.rule === "counterfactual_conviction_excess"),
    ).toBe(true);
  });

  it("counterfactual=strong + conviction=0.62 → BLOCKED (cap is 0.60)", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      tier: "review",
      confidence: 0.62,
      counterfactual_strength: "strong",
    });
    expect(r.ok).toBe(false);
    expect(
      r.violations.some((v) => v.rule === "counterfactual_conviction_excess"),
    ).toBe(true);
  });

  it("counterfactual=strong + conviction=0.60 → ok (at the cap)", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      tier: "review",
      confidence: 0.60,
      counterfactual_strength: "strong",
    });
    expect(
      r.violations.find((v) => v.rule === "counterfactual_conviction_excess"),
    ).toBeUndefined();
  });

  it("counterfactual=null → no cap rule fires", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      tier: "auto",
      confidence: 0.99,
      counterfactual_strength: null,
    });
    expect(
      r.violations.find((v) => v.rule === "counterfactual_conviction_excess"),
    ).toBeUndefined();
  });

  it("BOTH caps fire when both are violated (collected in one result)", () => {
    const r = checkSignalInvariants({
      ...baseSignal,
      tier: "auto",
      confidence: 0.85,
      mechanism_length: 4, // cap 0.55
      counterfactual_strength: "strong", // cap 0.60
    });
    expect(r.ok).toBe(false);
    expect(
      r.violations.some((v) => v.rule === "mechanism_conviction_excess"),
    ).toBe(true);
    expect(
      r.violations.some((v) => v.rule === "counterfactual_conviction_excess"),
    ).toBe(true);
  });
});
