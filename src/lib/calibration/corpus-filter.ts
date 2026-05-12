/**
 * Pre-classification corpus gate (Phase G, invariant I-46).
 *
 * The calibration corpus contains 95 verified historical events that
 * moved markets. Each event has a `source_event_text` describing the
 * real-world headline. This module uses those 95 strings as the
 * empirical reference for "what signal looks like" — a new headline is
 * embedded and scored by max cosine similarity against the corpus.
 *
 * The gate sits BEFORE the Claude classifier so we don't burn tokens
 * on headlines that don't structurally resemble anything the corpus has
 * ever observed. Replaces the previous "classify everything" default
 * with a corpus-anchored triage.
 *
 * Score = max_cosine_vs_corpus × asset_class_match_factor
 *   - asset_class_match_factor = 1.0 if any mentioned asset_class is in
 *     the corpus's covered universe (large_cap_crypto / mid_cap_crypto /
 *     small_cap_crypto / ai_semiconductor / big_tech / crypto_proxy /
 *     index), else 0.5 (corpus-silent class — extrapolating).
 *
 * Verdicts:
 *   score ≥ 0.30  → CLASSIFY     (full Claude call)
 *   0.15–0.30     → CLASSIFY     (marked weak_corpus_match for audit)
 *   < 0.15        → DROP         (logged to skipped_pre_classify)
 *
 * Companion tests: tests/corpus-filter.test.ts
 */

import { embed, cosineSimilarity } from "../pipeline/embeddings";
import {
  loadCorpus,
  type CalibrationCorpus,
  type CorpusEvent,
} from "./corpus";
import { classifyAssetClass } from "../pipeline/base-rates";

// Threshold constants — exported for visibility and testability.
export const CLASSIFY_THRESHOLD = 0.3;
export const FLAG_WEAK_THRESHOLD = 0.15;
// When the headline mentions zero asset_classes that the corpus covers,
// scale the cosine score down hard. Empirically the BoW embedding has a
// noise floor of ~0.4 for generic crypto-twitter language ("partnership",
// "announce", "moon") — without the asset-class penalty those would all
// score above the 0.15 drop threshold. A 0.3 multiplier pushes them to
// ~0.12 where they correctly drop.
export const NO_CORPUS_CLASS_PENALTY = 0.3;
// Signal-verb boost — additive bump applied when the title contains a
// strong factual verb that mirrors a corpus event shape (exploit, sanction,
// approve, acquire, etc.). Catches the false-negative case where a real
// catalyst names an asset we don't have in the quick-symbol list — e.g.
// "$5.87M stolen from TrustedVolumes" cosines high against defi_exploit
// anchors but the protocol name isn't in QUICK_SYMBOLS_BY_CLASS, so the
// 0.3 penalty drops it below 0.15. The verb boost surfaces these.
// Cap at 1.0 so the boost can't take a noise headline that happens to
// include a verb past the auto-classify threshold on its own.
export const SIGNAL_VERB_BOOST = 0.1;

export type CorpusFilterVerdict = "classify" | "flag_weak" | "drop";

export interface CorpusFilterInput {
  /** The full title text (post-sanitization). Required. */
  title: string;
  /** First few hundred chars of body content, if available. */
  content?: string | null;
  /** Symbols from SoSoValue's matched_currencies (e.g. ["BTC", "ETH"]). */
  matched_currency_symbols?: string[];
}

export interface CorpusFilterResult {
  score: number;
  max_cosine: number;
  /** Corpus event id of the closest match. */
  top_match_id: string | null;
  /** First 80 chars of the closest matching corpus headline. */
  top_match_text: string;
  /** Asset classes detected in the headline. */
  asset_classes_detected: string[];
  /** True when any detected class is in the corpus's covered universe. */
  asset_class_in_corpus: boolean;
  /** The drop/classify decision. */
  verdict: CorpusFilterVerdict;
  /** Human-readable trace for audit logging. */
  reasoning: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Corpus vector cache — embed once on first use, reuse thereafter.
// ─────────────────────────────────────────────────────────────────────────

interface CorpusVector {
  id: string;
  vec: number[];
  text: string;
  asset_class: string;
  subtype: string;
}

let _corpusVectors: CorpusVector[] | null = null;
let _corpusAssetClasses: Set<string> | null = null;

/** Build (and cache) the 95-vector reference set. */
function loadCorpusVectors(): {
  vectors: CorpusVector[];
  assetClasses: Set<string>;
} {
  if (_corpusVectors && _corpusAssetClasses) {
    return { vectors: _corpusVectors, assetClasses: _corpusAssetClasses };
  }
  const corpus = loadCorpus();
  _corpusVectors = corpus.events.map(buildVector);
  _corpusAssetClasses = new Set(corpus.events.map((e) => e.asset_class));
  return { vectors: _corpusVectors, assetClasses: _corpusAssetClasses };
}

function buildVector(e: CorpusEvent): CorpusVector {
  return {
    id: e.id,
    vec: embed(e.source_event_text),
    text: e.source_event_text,
    asset_class: e.asset_class,
    subtype: e.catalyst_subtype,
  };
}

/** Reset the cache. Tests only. */
export function _resetCorpusFilterCache(): void {
  _corpusVectors = null;
  _corpusAssetClasses = null;
}

/** Allow tests to inject a smaller corpus for deterministic asserts. */
export function _setCorpusFilterCache(corpus: CalibrationCorpus): void {
  _corpusVectors = corpus.events.map(buildVector);
  _corpusAssetClasses = new Set(corpus.events.map((e) => e.asset_class));
}

// ─────────────────────────────────────────────────────────────────────────
// Asset-class detection from a raw headline (pre-classification, so we
// can't use the full asset router yet — too expensive and depends on
// classifier output anyway).
// ─────────────────────────────────────────────────────────────────────────

/** Quick-look symbols → asset_class. Used pre-classification to gate the
 *  Claude call without invoking the full asset router. Non-exhaustive by
 *  design — false negatives just lose the asset_class match bonus, they
 *  don't auto-drop. */
const QUICK_SYMBOLS_BY_CLASS: Record<string, string[]> = {
  large_cap_crypto: ["BTC", "ETH", "BITCOIN", "ETHEREUM"],
  mid_cap_crypto: [
    "SOL", "XRP", "BNB", "ADA", "DOT", "AVAX", "DOGE", "TRX",
    "LINK", "LTC", "BCH", "NEAR", "APT", "ATOM", "ARB", "OP",
    "TON", "MATIC",
  ],
  ai_semiconductor: ["NVDA", "AMD", "AVGO", "MU", "TSM", "INTC", "QCOM"],
  big_tech: ["MSFT", "META", "GOOGL", "GOOG", "AMZN", "AAPL", "NFLX", "TSLA"],
  crypto_proxy: [
    "MSTR", "COIN", "MARA", "RIOT", "CLSK", "HUT", "HOOD",
    "GLXY", "IREN", "BTCS", "BMNR", "WULF", "BTBT", "CIFR",
  ],
  index: ["MAG7", "US500", "USTECH100", "SPX", "NDX"],
};

/**
 * Detect which corpus asset_classes the headline plausibly references.
 * Combines:
 *   - SoSoValue's matched_currencies (for crypto)
 *   - $TICKER patterns and bare-word ticker matches (for equities)
 */
export function detectAssetClasses(input: CorpusFilterInput): string[] {
  const found = new Set<string>();
  const upperTitle = ` ${input.title.toUpperCase()} ${(input.content ?? "").toUpperCase()} `;

  // Crypto via matched_currencies — most reliable. Map each symbol
  // through classifyAssetClass for canonical mapping.
  for (const sym of input.matched_currency_symbols ?? []) {
    const cls = classifyAssetClass({ kind: "token", symbol: sym });
    if (cls) found.add(cls);
  }

  // Equity/index via headline scan. Use word-boundary check to avoid
  // false positives ("AAVE" doesn't trigger AVE).
  for (const [cls, syms] of Object.entries(QUICK_SYMBOLS_BY_CLASS)) {
    for (const sym of syms) {
      // Match $TICKER or bare ticker on word boundary.
      const dollar = `$${sym}`;
      if (upperTitle.includes(` ${dollar} `) || upperTitle.includes(` ${dollar},`) || upperTitle.includes(` ${dollar}.`)) {
        found.add(cls);
        continue;
      }
      // Bare-word — surrounded by spaces or punctuation.
      const re = new RegExp(`(?:^|[^A-Z0-9])${sym}(?:$|[^A-Z0-9])`, "u");
      if (re.test(upperTitle)) {
        found.add(cls);
      }
    }
  }
  return Array.from(found);
}

// ─────────────────────────────────────────────────────────────────────────
// Top-level scorer
// ─────────────────────────────────────────────────────────────────────────

/**
 * Score a candidate headline against the corpus and emit a verdict.
 *
 * Pure — no DB writes. The caller (ingest/news.ts) is responsible for
 * persisting drops to `skipped_pre_classify` and routing classify
 * verdicts through to the Claude batch.
 */
export function corpusFilter(input: CorpusFilterInput): CorpusFilterResult {
  const { vectors, assetClasses } = loadCorpusVectors();
  if (vectors.length === 0) {
    // Defensive — corpus empty would imply infrastructure failure. Let
    // everything through so we don't silently break the pipeline.
    return {
      score: 1,
      max_cosine: 1,
      top_match_id: null,
      top_match_text: "",
      asset_classes_detected: [],
      asset_class_in_corpus: false,
      verdict: "classify",
      reasoning: "corpus empty — falling through to classify",
    };
  }

  // Combine title + a slice of content for embedding. Body slice is
  // capped because BoW embedding noise grows past ~250 chars.
  const text = input.content
    ? `${input.title} ${input.content.slice(0, 220)}`
    : input.title;
  const vec = embed(text);

  let maxCos = 0;
  let topMatch: CorpusVector | null = null;
  for (const v of vectors) {
    const sim = cosineSimilarity(vec, v.vec);
    if (sim > maxCos) {
      maxCos = sim;
      topMatch = v;
    }
  }

  const detected = detectAssetClasses(input);
  const classInCorpus = detected.some((c) => assetClasses.has(c));
  const baseScore = classInCorpus ? maxCos : maxCos * NO_CORPUS_CLASS_PENALTY;
  // Signal-verb boost rescues real catalysts with unfamiliar entity
  // names. Capped at 1.0.
  const verb = detectSignalVerbs(input.title);
  const score = Math.min(1, baseScore + verb.boost);

  let verdict: CorpusFilterVerdict;
  let why: string;
  if (score >= CLASSIFY_THRESHOLD) {
    verdict = "classify";
    why = `score ${score.toFixed(3)} ≥ ${CLASSIFY_THRESHOLD} — corpus shape match`;
  } else if (score >= FLAG_WEAK_THRESHOLD) {
    verdict = "classify";
    why = `score ${score.toFixed(3)} in weak band [${FLAG_WEAK_THRESHOLD}, ${CLASSIFY_THRESHOLD}) — classify with audit flag`;
  } else {
    verdict = "drop";
    why = `score ${score.toFixed(3)} < ${FLAG_WEAK_THRESHOLD} — no corpus shape, drop pre-classify`;
  }

  const verbTrace =
    verb.boost > 0 ? ` verbs=[${verb.matched.join(",")}] +${verb.boost.toFixed(2)}` : "";
  const reasoning =
    `${why}; max_cosine=${maxCos.toFixed(3)} top=${topMatch?.id ?? "—"};` +
    ` assets=[${detected.join(",") || "none"}] in_corpus=${classInCorpus}${verbTrace}`;

  return {
    score: roundN(score, 3),
    max_cosine: roundN(maxCos, 3),
    top_match_id: topMatch?.id ?? null,
    top_match_text: (topMatch?.text ?? "").slice(0, 80),
    asset_classes_detected: detected,
    asset_class_in_corpus: classInCorpus,
    verdict,
    reasoning,
  };
}

/**
 * Strong factual verbs that mirror corpus event shapes. Detect any →
 * apply SIGNAL_VERB_BOOST so the score reflects "this headline carries
 * the shape of a real catalyst even though the entity name isn't in
 * our quick-symbol list".
 *
 * Grouped for documentation but matched as a single word list. Each
 * entry must hit a word boundary in the headline (case-insensitive).
 *
 * Hedged forms (could, might, may, considering, rumored) are NOT here —
 * those drag the headline AWAY from a corpus shape, not toward it.
 */
const SIGNAL_VERBS: ReadonlyArray<string> = [
  // exploit / security
  "stolen", "drained", "drain", "exploit", "exploited", "hack", "hacked",
  "hacker", "breached", "compromised",
  // regulatory / sanction
  "approves", "approved", "rejects", "rejected", "sanctioned", "sanctions",
  "fines", "charged", "sues", "sued", "ruled", "ruling", "indicted",
  // M&A
  "acquires", "acquired", "acquisition", "acquiring", "merger", "merges",
  "merged",
  // earnings
  "beats", "missed", "misses", "reports", "reported",
  // treasury / corporate action
  "bought", "buys", "purchased", "accumulated", "acquired", "sold", "sells",
  // partnership / listing
  "partners", "partnered", "integrates", "integrated", "lists", "listed",
  "delists", "delisted", "launches", "launched",
  // unlock / token actions
  "unlocks", "unlocked", "burned", "burns", "minted", "minting",
];

/** Detect any signal verb in the headline. Returns the matched verbs
 *  (useful for audit) and whether the boost should apply. */
export function detectSignalVerbs(headline: string): {
  matched: string[];
  boost: number;
} {
  const lc = ` ${headline.toLowerCase()} `;
  const matched: string[] = [];
  for (const v of SIGNAL_VERBS) {
    // Word-boundary check — "approve" should match "approves" already,
    // but we want to avoid substring hits like "ruled" in "scheduled".
    const re = new RegExp(`(?:^|[^a-z])${v}(?:$|[^a-z])`, "i");
    if (re.test(lc)) matched.push(v);
  }
  return {
    matched,
    boost: matched.length > 0 ? SIGNAL_VERB_BOOST : 0,
  };
}

/** Convenience — is this verdict the weak-band classify? */
export function isWeakCorpusMatch(result: CorpusFilterResult): boolean {
  return (
    result.verdict === "classify" &&
    result.score < CLASSIFY_THRESHOLD &&
    result.score >= FLAG_WEAK_THRESHOLD
  );
}

function roundN(n: number, d: number): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}
