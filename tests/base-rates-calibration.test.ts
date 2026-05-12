/**
 * Empirical base-rate derivation tests (Phase B).
 *
 * Verifies the (subtype, asset_class) → BaseRate table that
 * scripts/calibrate-base-rates.ts produces from the calibration corpus.
 */

import { describe, it, expect } from "vitest";
import { loadCorpus } from "../src/lib/calibration/corpus";
import {
  deriveBaseRates,
  lookupDerivedRate,
  lookupWithFallback,
} from "../src/lib/calibration/derive-base-rates";

describe("base-rate derivation", () => {
  it("produces a non-empty table over every (subtype, asset_class) in the corpus", () => {
    const corpus = loadCorpus();
    const table = deriveBaseRates(corpus);
    const subtypeKeys = Object.keys(table).filter((k) => k !== "_schema");
    expect(subtypeKeys.length).toBeGreaterThan(0);

    // Every (subtype, class) seen in the corpus must have a derived cell.
    const seenPairs = new Set<string>();
    for (const e of corpus.events) {
      seenPairs.add(`${e.catalyst_subtype}::${e.asset_class}`);
    }
    for (const pair of seenPairs) {
      const [subtype, cls] = pair.split("::");
      const rate = lookupDerivedRate(table, subtype!, cls!);
      expect(rate, `missing derived rate for ${pair}`).not.toBeNull();
    }

    // Schema metadata is preserved.
    const schema = table._schema as { source: string };
    expect(schema.source).toMatch(/calibration-corpus\.json/);
  });

  it("applies confidence weights — recent (0.5) events pull less than high (1.0)", () => {
    // Synthesise a corpus where two recent (0.5) outliers + one high (1.0)
    // event compete. Confidence-weighted mean should land closer to the
    // high event than a naive arithmetic mean would.
    const corpus = loadCorpus();
    const synthetic = {
      ...corpus,
      events: [
        {
          id: "syn-1",
          date: "2025-01-01",
          asset: "TEST",
          asset_class: "test_class",
          catalyst_subtype: "test_subtype",
          direction: "long" as const,
          realized_pct_move: 10,
          duration_to_peak_days: 1,
          duration_of_impact_days: 1,
          source_event_text: "anchor",
          confidence: "high" as const,
          notes: "",
        },
        {
          id: "syn-2",
          date: "2025-01-02",
          asset: "TEST",
          asset_class: "test_class",
          catalyst_subtype: "test_subtype",
          direction: "long" as const,
          realized_pct_move: 30,
          duration_to_peak_days: 1,
          duration_of_impact_days: 1,
          source_event_text: "recent outlier 1",
          confidence: "recent" as const,
          notes: "",
        },
        {
          id: "syn-3",
          date: "2025-01-03",
          asset: "TEST",
          asset_class: "test_class",
          catalyst_subtype: "test_subtype",
          direction: "long" as const,
          realized_pct_move: 30,
          duration_to_peak_days: 1,
          duration_of_impact_days: 1,
          source_event_text: "recent outlier 2",
          confidence: "recent" as const,
          notes: "",
        },
      ],
    };
    const table = deriveBaseRates(synthetic);
    const rate = lookupDerivedRate(table, "test_subtype", "test_class");
    expect(rate).not.toBeNull();
    // Naive mean would be 23.3. Weighted (1.0*10 + 0.5*30 + 0.5*30) / 2.0 = 20.
    expect(rate!.mean_move_pct).toBe(20);
    expect(rate!.sample_size).toBe(3);
  });

  it("handles small samples — n=1 stdev defaults, n=2 floored, n≥3 uses stdev", () => {
    const corpus = loadCorpus();

    // n=1 case from corpus: regulatory_etf_approval is a single high-conf event.
    const table = deriveBaseRates(corpus);
    const n1 = lookupDerivedRate(table, "regulatory_etf_approval", "large_cap_crypto");
    expect(n1).not.toBeNull();
    expect(n1!.sample_size).toBe(1);
    // stdev = 0.6 * |mean|.
    expect(n1!.stdev_move_pct).toBe(Math.round(0.6 * n1!.mean_move_pct * 10) / 10);
    expect(n1!.notes).toMatch(/n=1 single-anchor/);

    // n=2 case: ensure the floor fires when natural stdev would be lower
    // than 0.4 * mean. Two events at 100 and 102 → mean 101, raw stdev ~1,
    // floor at 40.4 (0.4 * 101).
    const synthetic = {
      ...corpus,
      events: [
        {
          id: "n2-a",
          date: "2025-01-01",
          asset: "T",
          asset_class: "cls",
          catalyst_subtype: "n2_subtype",
          direction: "long" as const,
          realized_pct_move: 100,
          duration_to_peak_days: 1,
          duration_of_impact_days: 1,
          source_event_text: "a",
          confidence: "high" as const,
          notes: "",
        },
        {
          id: "n2-b",
          date: "2025-01-02",
          asset: "T",
          asset_class: "cls",
          catalyst_subtype: "n2_subtype",
          direction: "long" as const,
          realized_pct_move: 102,
          duration_to_peak_days: 1,
          duration_of_impact_days: 1,
          source_event_text: "b",
          confidence: "high" as const,
          notes: "",
        },
      ],
    };
    const t2 = deriveBaseRates(synthetic);
    const n2 = lookupDerivedRate(t2, "n2_subtype", "cls");
    expect(n2!.sample_size).toBe(2);
    // mean = 101, floor = 0.4 * 101 = 40.4. Raw stdev ~1, so floor wins.
    expect(n2!.stdev_move_pct).toBeGreaterThanOrEqual(40);
    expect(n2!.notes).toMatch(/n=2/);

    // n≥3 case: corpus etf_flow_reaction × large_cap_crypto has 8 events.
    const n8 = lookupDerivedRate(table, "etf_flow_reaction", "large_cap_crypto");
    expect(n8).not.toBeNull();
    expect(n8!.sample_size).toBe(8);
    // Should not have the small-sample suffix.
    expect(n8!.notes).not.toMatch(/single-anchor|floored/);
  });

  it("falls back across asset classes within the same subtype", () => {
    const corpus = loadCorpus();
    const table = deriveBaseRates(corpus);
    // halving_event only has large_cap_crypto in the corpus. A lookup for
    // mid_cap_crypto should fall back rather than return null.
    const direct = lookupDerivedRate(table, "halving_event", "mid_cap_crypto");
    expect(direct).toBeNull();
    const fb = lookupWithFallback(table, "halving_event", "mid_cap_crypto");
    expect(fb).not.toBeNull();
    expect(fb!.from_class).toBe("large_cap_crypto");
    expect(fb!.rate.mean_move_pct).toBeGreaterThan(0);

    // Direct hit keeps from_class equal to the requested class.
    const directHit = lookupWithFallback(table, "etf_flow_reaction", "large_cap_crypto");
    expect(directHit!.from_class).toBe("large_cap_crypto");
  });
});
