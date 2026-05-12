/**
 * Calibration corpus — schema and integrity tests (Phase A).
 *
 * Verifies that data/calibration-corpus.json loads, parses, and passes
 * all validation rules in src/lib/calibration/corpus.ts. The corpus is
 * the source of truth for empirical base rates (invariant I-44).
 */

import { describe, it, expect } from "vitest";
import {
  loadCorpus,
  validateCorpus,
  KNOWN_SUBTYPES,
  KNOWN_ASSET_CLASSES,
  type CalibrationCorpus,
} from "../src/lib/calibration/corpus";

describe("calibration corpus", () => {
  it("loads from disk and matches the documented schema", () => {
    const corpus = loadCorpus();
    expect(corpus.schema_version).toBeTruthy();
    expect(typeof corpus.schema_version).toBe("string");
    expect(corpus.generated_at).toBeTruthy();
    expect(isNaN(Date.parse(corpus.generated_at))).toBe(false);
    expect(Array.isArray(corpus.events)).toBe(true);
    expect(corpus.events.length).toBeGreaterThanOrEqual(95);
    expect(Array.isArray(corpus.taxonomy_extensions)).toBe(true);
    expect(corpus.taxonomy_extensions.length).toBeGreaterThanOrEqual(13);
  });

  it("passes all validation rules with zero errors", () => {
    const corpus = loadCorpus();
    const result = validateCorpus(corpus, KNOWN_SUBTYPES);
    if (result.errors.length > 0) {
      // Fail loud and surface the first 5 violations so the test report
      // points at the actual problem rather than a generic mismatch.
      console.error("Validation errors:", result.errors.slice(0, 5));
    }
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.total_events).toBe(corpus.events.length);
  });

  it("uses only known catalyst_subtype values (no R13 warnings)", () => {
    const corpus = loadCorpus();
    const result = validateCorpus(corpus, KNOWN_SUBTYPES);
    const unknown = result.warnings.filter((w) => w.rule === "R13_subtype_known");
    if (unknown.length > 0) {
      console.error("Unknown subtypes in corpus:", unknown.slice(0, 5));
    }
    expect(unknown).toEqual([]);
  });

  it("uses only known asset_class values", () => {
    const corpus = loadCorpus();
    for (const e of corpus.events) {
      expect(KNOWN_ASSET_CLASSES.has(e.asset_class)).toBe(true);
    }
  });

  it("has no duplicate event ids and dates are monotonic-friendly", () => {
    const corpus = loadCorpus();
    const ids = new Set<string>();
    for (const e of corpus.events) {
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
      // Date is parseable
      expect(isNaN(new Date(e.date).getTime())).toBe(false);
    }
    // Cross-check the rule-engine version finds zero R6 violations.
    const result = validateCorpus(corpus, KNOWN_SUBTYPES);
    const dups = result.errors.filter((e) => e.rule === "R6_unique_id");
    expect(dups).toEqual([]);
  });

  it("detects fabricated errors when the corpus is mutated (negative case)", () => {
    const corpus = loadCorpus();
    // Create a deliberately broken copy.
    const bad: CalibrationCorpus = {
      ...corpus,
      events: [
        ...corpus.events.slice(0, 2),
        {
          ...corpus.events[0]!,
          // duplicate id of events[0]
          realized_pct_move: NaN as unknown as number,
        },
        {
          ...corpus.events[1]!,
          id: "bad-date",
          date: "not-a-date",
        },
      ],
    };
    const result = validateCorpus(bad, KNOWN_SUBTYPES);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.rule === "R6_unique_id")).toBe(true);
    expect(result.errors.some((e) => e.rule === "R7_date_format")).toBe(true);
    expect(result.errors.some((e) => e.rule === "R10_realized_pct_move")).toBe(true);
  });
});
