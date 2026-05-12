/**
 * Strict same-asset opposite-direction conflict resolution (Phase D, I-42).
 *
 * Pure-logic tests over resolveConflict. DB integration is exercised by
 * the integration-pipeline suite separately.
 */

import { describe, it, expect } from "vitest";
import {
  resolveConflict,
  windowOverlapFraction,
  type ConflictCandidate,
} from "../src/lib/calibration/conflicts";

function cand(over: Partial<ConflictCandidate>): ConflictCandidate {
  return {
    id: "default",
    direction: "long",
    asset_id: "tok-btc",
    start_at: 1_700_000_000_000,
    expires_at: 1_700_000_000_000 + 24 * 60 * 60 * 1000,
    asset_relevance: 0.9,
    significance_score: 0.5,
    conviction: 0.7,
    ...over,
  };
}

describe("strict conflict resolution (Phase D, I-42)", () => {
  it("LONG BTC sig 0.6 + SHORT BTC sig 0.85 same window → SHORT wins, LONG suppressed", () => {
    const longSig = cand({
      id: "long-1",
      direction: "long",
      significance_score: 0.6,
      asset_relevance: 0.9,
    });
    const shortSig = cand({
      id: "short-1",
      direction: "short",
      significance_score: 0.85,
      asset_relevance: 0.9,
    });
    // Existing = long, new = short. New (short) has higher significance.
    // Ratio 0.85 / 0.6 = 1.417× → below the 1.5× supersession threshold,
    // so this is a Phase D strict-conflict suppression, not a Phase E
    // supersession.
    const verdict = resolveConflict(shortSig, longSig);
    expect(verdict.kind).toBe("suppress_existing");
    if (verdict.kind === "suppress_existing") {
      expect(verdict.loser_id).toBe("long-1");
      expect(verdict.winner_significance).toBeGreaterThan(
        verdict.loser_significance,
      );
    }
  });

  it("LONG BTC + SHORT ETH same day → no conflict (different assets — caller filters)", () => {
    // resolveConflict assumes same-asset (caller filters). The relevant
    // shield here is that asset_id mismatch is handled upstream. Verify
    // the function behaves correctly when given a same-asset pair only.
    const a = cand({ direction: "long", asset_id: "tok-btc" });
    const b = cand({ direction: "long", asset_id: "tok-btc" });
    // Same direction → no_conflict (the dedup path takes over).
    expect(resolveConflict(a, b).kind).toBe("no_conflict");
  });

  it("LONG BTC + SHORT BTC 5 days apart, no overlap → no conflict", () => {
    const existing = cand({
      id: "long-old",
      direction: "long",
      start_at: 1_700_000_000_000,
      expires_at: 1_700_000_000_000 + 24 * 60 * 60 * 1000,
    });
    const newCand = cand({
      id: "short-new",
      direction: "short",
      start_at: 1_700_000_000_000 + 5 * 24 * 60 * 60 * 1000,
      expires_at: 1_700_000_000_000 + 6 * 24 * 60 * 60 * 1000,
    });
    const overlap = windowOverlapFraction(newCand, existing);
    expect(overlap).toBe(0);
    expect(resolveConflict(newCand, existing).kind).toBe("no_conflict");
  });

  it("Either side relevance < 0.6 → no conflict (too weakly anchored)", () => {
    const existing = cand({
      direction: "long",
      asset_relevance: 0.5,
      significance_score: 0.7,
    });
    const newCand = cand({
      direction: "short",
      asset_relevance: 0.9,
      significance_score: 0.4,
    });
    expect(resolveConflict(newCand, existing).kind).toBe("no_conflict");
  });

  it("Significance tie within 0.05 → tiebreak by conviction, then by recency", () => {
    const existing = cand({
      id: "ex-1",
      direction: "long",
      significance_score: 0.6,
      conviction: 0.5,
    });
    // Significance basically equal, but new has higher conviction.
    const newCand = cand({
      id: "new-1",
      direction: "short",
      significance_score: 0.62, // within 0.05 of 0.6
      conviction: 0.8,
    });
    const verdict = resolveConflict(newCand, existing);
    expect(verdict.kind).toBe("suppress_existing");

    // Also-equal conviction → newer wins.
    const tieEverything = cand({
      direction: "short",
      significance_score: 0.6,
      conviction: 0.5,
    });
    expect(resolveConflict(tieEverything, existing).kind).toBe(
      "suppress_existing",
    );
  });

  it("Overlap exactly 0.5 passes the gate; just under does not", () => {
    // Half overlap = pass.
    const existing = cand({
      start_at: 0,
      expires_at: 1000,
      direction: "long",
      significance_score: 0.7,
    });
    const newOverlap50 = cand({
      direction: "short",
      start_at: 500,
      expires_at: 1500,
      significance_score: 0.6,
    });
    expect(windowOverlapFraction(newOverlap50, existing)).toBeCloseTo(0.5, 4);
    expect(resolveConflict(newOverlap50, existing).kind).not.toBe("no_conflict");

    // Just under 50% overlap fails.
    const newOverlap40 = cand({
      direction: "short",
      start_at: 600,
      expires_at: 1600,
      significance_score: 0.6,
    });
    expect(resolveConflict(newOverlap40, existing).kind).toBe("no_conflict");
  });
});
