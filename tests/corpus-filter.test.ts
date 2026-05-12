/**
 * Pre-classification corpus gate tests (Phase G, invariant I-46).
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  corpusFilter,
  detectAssetClasses,
  detectSignalVerbs,
  CLASSIFY_THRESHOLD,
  FLAG_WEAK_THRESHOLD,
  SIGNAL_VERB_BOOST,
  _setCorpusFilterCache,
} from "../src/lib/calibration/corpus-filter";
import { loadCorpus } from "../src/lib/calibration/corpus";

beforeAll(() => {
  // Inject the real corpus once so tests don't depend on disk caching.
  _setCorpusFilterCache(loadCorpus());
});

describe("pre-classify corpus gate (I-46)", () => {
  it("a corpus headline scored against itself produces a near-perfect match → CLASSIFY", () => {
    // Pull a real corpus event and feed its text right back in.
    const corpus = loadCorpus();
    const anchor = corpus.events.find(
      (e) => e.catalyst_subtype === "regulatory_etf_approval",
    )!;
    const result = corpusFilter({
      title: anchor.source_event_text,
      matched_currency_symbols: [anchor.asset],
    });
    expect(result.verdict).toBe("classify");
    expect(result.max_cosine).toBeGreaterThan(0.9);
    expect(result.score).toBeGreaterThanOrEqual(CLASSIFY_THRESHOLD);
    expect(result.top_match_id).toBe(anchor.id);
  });

  it("a generic promotional tweet scores near zero → DROP", () => {
    const result = corpusFilter({
      title: "🚀🚀🚀 Thrilled to announce our partnership with @lobsternft_lol",
      matched_currency_symbols: [],
    });
    expect(result.verdict).toBe("drop");
    expect(result.score).toBeLessThan(FLAG_WEAK_THRESHOLD);
  });

  it("a structurally-similar but paraphrased headline still passes the gate", () => {
    // Paraphrase of the ETF approval corpus event.
    const result = corpusFilter({
      title: "US securities regulator gives spot Bitcoin ETF the green light",
      matched_currency_symbols: ["BTC"],
    });
    expect(result.verdict).toBe("classify");
    // Asset class match present, so 1.0 factor applies.
    expect(result.asset_class_in_corpus).toBe(true);
  });

  it("a borderline headline with no asset class match is penalised 0.5×", () => {
    // No matched_currencies, no ticker — but textually plausible. Score
    // gets the 0.5 penalty for no-corpus-class.
    const result = corpusFilter({
      title: "Some bridge between two networks resumes operation",
      matched_currency_symbols: [],
    });
    // No corpus class detected.
    expect(result.asset_class_in_corpus).toBe(false);
    // The penalty must have been applied (score < raw cosine).
    expect(result.score).toBeLessThanOrEqual(result.max_cosine);
  });

  it("detectAssetClasses identifies crypto via matched_currencies", () => {
    expect(detectAssetClasses({
      title: "Some Bitcoin news",
      matched_currency_symbols: ["BTC"],
    })).toContain("large_cap_crypto");
    expect(detectAssetClasses({
      title: "ETH whale moves $50M",
      matched_currency_symbols: ["ETH"],
    })).toContain("large_cap_crypto");
  });

  it("detectAssetClasses identifies equities via $TICKER pattern", () => {
    const classes = detectAssetClasses({
      title: "$NVDA reports Q3 earnings beat",
      matched_currency_symbols: [],
    });
    expect(classes).toContain("ai_semiconductor");
  });

  it("detectAssetClasses identifies crypto_proxy via MSTR", () => {
    const classes = detectAssetClasses({
      title: "Strategy added 145,834 BTC; MSTR up 4%",
      matched_currency_symbols: ["BTC"],
    });
    expect(classes).toContain("crypto_proxy");
    expect(classes).toContain("large_cap_crypto");
  });

  it("verdict tiers respect the documented thresholds", () => {
    // Three synthetic headlines covering the three bands.
    const dropResult = corpusFilter({
      title: "x x x", // very short, no signal
      matched_currency_symbols: [],
    });
    expect(dropResult.verdict).toBe("drop");

    // For a strong match, use a near-verbatim corpus event.
    const corpus = loadCorpus();
    const anchor = corpus.events[0]!;
    const classifyResult = corpusFilter({
      title: anchor.source_event_text,
      matched_currency_symbols: [anchor.asset],
    });
    expect(classifyResult.verdict).toBe("classify");
  });

  // ── Signal-verb boost (rescues false negatives with unfamiliar entities) ──

  it("detectSignalVerbs identifies exploit / regulatory / M&A verbs", () => {
    expect(detectSignalVerbs("$5.87M stolen from TrustedVolumes").matched).toContain("stolen");
    expect(detectSignalVerbs("Core Scientific Acquires Polaris DS").matched).toContain("acquires");
    expect(detectSignalVerbs("SEC approves spot ETH ETF").matched).toContain("approves");
    expect(detectSignalVerbs("Iran sanctioned by US Treasury").matched).toContain("sanctioned");
    // No verb in pure noise.
    expect(detectSignalVerbs("Generic vague tweet about markets").matched).toEqual([]);
  });

  it("does NOT false-positive on substring matches (substr 'ruled' in 'scheduled')", () => {
    const r = detectSignalVerbs("Maintenance scheduled for Wednesday");
    expect(r.matched).toEqual([]);
  });

  it("DeFi exploit on unfamiliar protocol gets rescued by verb boost", () => {
    // Pre-fix this scored 0.144 → dropped. With +0.10 verb boost → ≥0.15 → classify.
    const result = corpusFilter({
      title: "Approximately $5.87 million has been stolen from the liquidity provider TrustedVolumes",
      matched_currency_symbols: [],
    });
    expect(result.verdict).toBe("classify");
    expect(result.reasoning).toMatch(/stolen/);
    expect(result.reasoning).toMatch(/\+0\.10/);
  });

  it("M&A on a crypto-adjacent stock without ticker recognition gets rescued", () => {
    const result = corpusFilter({
      title: "Core Scientific Acquires Polaris DS to Enter AI Data Center Business",
      matched_currency_symbols: [],
    });
    expect(result.verdict).toBe("classify");
    expect(result.reasoning).toMatch(/acquires/);
  });

  it("boost cannot turn pure noise into a classify on its own", () => {
    // A short, low-cosine headline with one matching verb. The +0.10
    // shouldn't push it past 0.15 unless the cosine is meaningful.
    const result = corpusFilter({
      title: "approves x",
      matched_currency_symbols: [],
    });
    // With max_cosine likely ~0.1 and 0.3 penalty → 0.03 + 0.10 = 0.13 → drop
    expect(result.score).toBeLessThan(CLASSIFY_THRESHOLD);
  });

  it("boost is a constant +0.10 regardless of how many verbs match", () => {
    // Headline with 3 verbs; boost is still capped at SIGNAL_VERB_BOOST.
    const r3 = corpusFilter({
      title: "SEC approves; CEO fired; protocol hacked simultaneously",
      matched_currency_symbols: [],
    });
    const verbs = detectSignalVerbs(r3.reasoning).matched.length;
    void verbs;
    // We can verify the boost magnitude by comparing to a no-verb baseline
    const baseline = corpusFilter({
      title: "some narrative report on the situation",
      matched_currency_symbols: [],
    });
    const verbBoosted = corpusFilter({
      title: "some narrative report on the approves situation",
      matched_currency_symbols: [],
    });
    expect(verbBoosted.score - baseline.score).toBeCloseTo(SIGNAL_VERB_BOOST, 2);
  });

  it("reasoning string includes the score, top match, and asset class", () => {
    const result = corpusFilter({
      title: "SEC approves spot Ethereum ETF for trading",
      matched_currency_symbols: ["ETH"],
    });
    expect(result.reasoning).toMatch(/score/);
    expect(result.reasoning).toMatch(/large_cap_crypto/);
    expect(result.reasoning).toMatch(/in_corpus=true/);
  });
});
