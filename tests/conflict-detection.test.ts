import { describe, expect, it } from "vitest";
import { computeConflict } from "@/lib/pipeline/conflict";
import { ASSET_RELEVANCE_SCORE } from "@/lib/pipeline/types";

const longSubject = {
  asset_id: "tok-arb",
  direction: "long" as const,
  conviction: 0.7,
  asset_relevance: ASSET_RELEVANCE_SCORE.subject,
};
const shortSubject = {
  asset_id: "tok-arb",
  direction: "short" as const,
  conviction: 0.65,
  asset_relevance: ASSET_RELEVANCE_SCORE.subject,
};
const incidentalShort = {
  asset_id: "tok-arb",
  direction: "short" as const,
  conviction: 0.6,
  asset_relevance: ASSET_RELEVANCE_SCORE.incidentally_mentioned, // 0.3
};

describe("Bug class 5 — relevance-weighted conflict detection", () => {
  it("registers a real conflict when both signals are subjects", () => {
    const r = computeConflict(longSubject, shortSubject);
    expect(r.kind).toBe("conflict");
  });

  it("does NOT register a conflict when one signal is incidental", () => {
    // Real example: LayerZero systemic vulnerability flagged ARB
    // incidentally — should not conflict with an ARB-specific
    // governance signal where ARB is the subject.
    const r = computeConflict(longSubject, incidentalShort);
    expect(r.kind).toBe("related_context");
    expect(r.kind).not.toBe("conflict");
  });

  it("returns no_overlap when assets differ", () => {
    const r = computeConflict(longSubject, {
      ...shortSubject,
      asset_id: "tok-eth",
    });
    expect(r.kind).toBe("no_overlap");
  });

  it("returns no_overlap when directions match", () => {
    const r = computeConflict(longSubject, {
      ...longSubject,
      conviction: 0.6,
    });
    expect(r.kind).toBe("no_overlap");
  });

  it("computes net long/short conviction", () => {
    // Both subjects, opposite directions, asymmetric convictions.
    const r = computeConflict(longSubject, shortSubject);
    expect(r.net_long_conviction).toBe(0.7);
    expect(r.net_short_conviction).toBe(0.65);
  });

  it("registers conflict at the relevance boundary (>= 0.6 both)", () => {
    const directlyAffected = {
      asset_id: "tok-arb",
      direction: "short" as const,
      conviction: 0.7,
      asset_relevance: ASSET_RELEVANCE_SCORE.directly_affected, // 0.8
    };
    const r = computeConflict(longSubject, directlyAffected);
    expect(r.kind).toBe("conflict");
  });

  it("does NOT register conflict when only one side is at 0.5 (basket)", () => {
    const basketSide = {
      asset_id: "tok-arb",
      direction: "short" as const,
      conviction: 0.6,
      asset_relevance: ASSET_RELEVANCE_SCORE.basket_with_member, // 0.5
    };
    const r = computeConflict(longSubject, basketSide);
    // 0.5 < 0.6 threshold — related context, not conflict
    expect(r.kind).toBe("related_context");
  });
});
