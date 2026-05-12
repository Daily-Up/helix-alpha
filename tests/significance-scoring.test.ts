/**
 * Significance scoring tests (Phase C, invariant I-41).
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  scoreSignificance,
  scoreInstanceStrength,
  scoreNovelty,
  tierForScore,
  _setBaseRatesTable,
} from "../src/lib/calibration/significance";
import { loadCorpus } from "../src/lib/calibration/corpus";
import { deriveBaseRates } from "../src/lib/calibration/derive-base-rates";

beforeAll(() => {
  // Use freshly derived base rates so the tests do not depend on the
  // generated file being present in the test environment.
  const corpus = loadCorpus();
  const table = deriveBaseRates(corpus);
  _setBaseRatesTable(table);
});

describe("significance scoring", () => {
  it("ETF approval headline scores ≥0.75 (tier=auto)", () => {
    const result = scoreSignificance({
      headline: "SEC approves spot BTC ETF",
      subtype: "regulatory_etf_approval",
      asset_class: "large_cap_crypto",
      asset_relevance: 1.0,
      recent_headlines: [],
    });
    expect(result.tier).toBe("auto");
    expect(result.score).toBeGreaterThanOrEqual(0.75);
  });

  it("Generic price-holds headline scores <0.25 and is tagged drop", () => {
    const result = scoreSignificance({
      headline: "BTC holds above $80K amid steady volume",
      subtype: "other",
      asset_class: "large_cap_crypto",
      asset_relevance: 0.3, // incidentally_mentioned
      recent_headlines: [],
    });
    expect(result.tier).toBe("drop");
    expect(result.score).toBeLessThan(0.25);
  });

  it("Hedged headline scores lower than factual headline of same subtype", () => {
    const factual = scoreSignificance({
      headline: "SEC approves spot ETH ETF",
      subtype: "regulatory_etf_approval",
      asset_class: "large_cap_crypto",
      asset_relevance: 1.0,
      recent_headlines: [],
    });
    const hedged = scoreSignificance({
      headline: "Rumors of potential ETH ETF discussion at SEC",
      subtype: "regulatory_etf_approval",
      asset_class: "large_cap_crypto",
      asset_relevance: 1.0,
      recent_headlines: [],
    });
    expect(hedged.score).toBeLessThan(factual.score);
    // Hedged should also have a lower instance_strength component
    expect(hedged.components.instance_strength).toBeLessThan(
      factual.components.instance_strength,
    );
  });

  it("Novelty: a 3rd similar headline within 7d gets component ≤ 0.1", () => {
    const previous = [
      "SEC approves spot BTC ETF on Wall Street",
      "SEC approves spot BTC ETF for trading",
    ];
    const nv = scoreNovelty("SEC approves spot BTC ETF this morning", previous);
    expect(nv.score).toBeLessThanOrEqual(0.1);
    expect(nv.similar_count).toBeGreaterThanOrEqual(2);
  });

  it("Tier threshold boundaries map cleanly to {auto, review, info, drop}", () => {
    expect(tierForScore(0.85)).toBe("auto");
    expect(tierForScore(0.75)).toBe("auto");
    expect(tierForScore(0.749)).toBe("review");
    expect(tierForScore(0.5)).toBe("review");
    expect(tierForScore(0.499)).toBe("info");
    expect(tierForScore(0.25)).toBe("info");
    expect(tierForScore(0.249)).toBe("drop");
    expect(tierForScore(0)).toBe("drop");
  });

  it("Weighted components sum to overall score within rounding tolerance", () => {
    const result = scoreSignificance({
      headline: "SEC approves spot SOL ETF",
      subtype: "regulatory_etf_approval",
      asset_class: "large_cap_crypto",
      asset_relevance: 0.8,
      recent_headlines: [],
    });
    const expected =
      0.5 * result.components.magnitude +
      0.3 * result.components.instance_strength +
      0.2 * result.components.novelty;
    // Allow tolerance because each component is rounded to 3 places.
    expect(Math.abs(expected - result.score)).toBeLessThan(0.005);
  });

  // ── Regression tests for the legacy-fallback NULL bug (I-45) ──
  // Pre-fix, signals with subtypes outside the corpus would skip
  // significance scoring entirely and persist with NULL. The fix routes
  // them through the legacy table or, when absent, magnitude=0 — but the
  // 3-component score still runs and returns a real number.

  it("subtype 'security_disclosure' (not in corpus) routes through legacy fallback and returns a non-null score", () => {
    // security_disclosure × small_cap_crypto is in the legacy hand-curated
    // table (src/lib/pipeline/base_rates.json) but NOT in the corpus.
    // Pre-fix this combination would skip significance scoring entirely.
    const result = scoreSignificance({
      headline: "Critical vulnerability disclosed in protocol multisig",
      subtype: "security_disclosure",
      asset_class: "small_cap_crypto",
      asset_relevance: 0.9,
      recent_headlines: [],
    });
    // The score itself must be a real number, not null/undefined.
    expect(result.score).toBeTypeOf("number");
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThan(0);
    // Came from legacy table — base_rate_from_class is tagged "(legacy)".
    expect(result.base_rate_from_class).not.toBeNull();
    expect(result.base_rate_from_class!).toMatch(/legacy/);
  });

  it("subtype with no corpus AND no legacy entry still gets scored (magnitude=0, instance+novelty produce final score)", () => {
    const result = scoreSignificance({
      headline: "Some completely uncategorised event happened",
      subtype: "completely_made_up_subtype_xyz" as string,
      asset_class: "large_cap_crypto",
      asset_relevance: 0.8,
      recent_headlines: [],
    });
    expect(result.score).toBeTypeOf("number");
    expect(Number.isFinite(result.score)).toBe(true);
    // With magnitude=0 the magnitude gate caps the score at 0.4 ×
    // (0.3 × instance + 0.2 × novelty). For a neutral headline (instance
    // ≈ 0.6, novelty = 1.0) that's 0.4 × (0.18 + 0.2) = 0.152 → drop tier.
    expect(result.tier).toBe("drop");
    expect(result.score).toBeLessThan(0.25);
  });

  it("unknown asset_class string is tolerated; scorer still returns a finite number for the I-45 path", () => {
    // The signal-generator passes "unknown" as a sentinel when
    // classifyAssetClass returns null (e.g. macro-kind primary asset).
    // We don't care which fallback path wins — only that we ALWAYS get a
    // finite score so the signal can persist with non-null
    // significance_score per invariant I-45.
    const result = scoreSignificance({
      headline: "Some event on an unmapped asset",
      subtype: "regulatory_etf_approval",
      asset_class: "unknown",
      asset_relevance: 0.8,
      recent_headlines: [],
    });
    expect(result.score).toBeTypeOf("number");
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThan(0);
    // tier must be one of the four canonical values, never null.
    expect(["auto", "review", "info", "drop"]).toContain(result.tier);
  });

  it("Instance strength: strong verbs lift score; multiple hedges push to floor 0.1", () => {
    const strong = scoreInstanceStrength("Coinbase fires CEO, drains exec ranks");
    expect(strong.score).toBeGreaterThan(0.8);
    expect(strong.hits.length).toBeGreaterThanOrEqual(2);

    const weak = scoreInstanceStrength(
      "Rumored potential discussion of possible reportedly speculative move",
    );
    expect(weak.score).toBeCloseTo(0.1, 1);
    expect(weak.hedges.length).toBeGreaterThanOrEqual(4);
  });
});
