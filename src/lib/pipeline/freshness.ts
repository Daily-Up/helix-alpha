/**
 * Stage 1.5 — Semantic freshness gate.
 *
 * Sits between ingestion and classification. Catches the kind of
 * duplicate the existing event-id dedup misses: two outlets covering
 * the same Coinbase outage with different verbs and tag sets — they
 * hash differently, but they're the same event.
 *
 * Pure function: given the new article's embedding and a list of
 * recent classifications' embeddings, return one of three verdicts:
 *
 *   - duplicate    sim > duplicate_threshold     → drop the article
 *   - continuation [contin..duplicate)           → classify, flag low-novelty
 *   - novel        sim < continuation_threshold  → proceed normally
 *
 * Thresholds are MODEL-SPECIFIC. Bag-of-words pseudo-embeddings (our
 * default) score paraphrased coverage of the same event in the
 * 0.50–0.75 band; sentence transformers (e.g. all-MiniLM-L6-v2) push
 * the same pairs to 0.80+. We expose the thresholds as constants and
 * default them for the active embedder. When a real sentence
 * transformer is wired in, override via the `thresholds` argument.
 *
 *   BoW defaults:   duplicate=0.55, continuation=0.42
 *   Sentence-T:     duplicate=0.85, continuation=0.75
 *
 * Companion tests: tests/freshness.test.ts.
 *
 * Invariants: I-25 (PIPELINE_INVARIANTS.md).
 */

import { cosineSimilarity } from "./embeddings";

export type FreshnessVerdict = "novel" | "continuation" | "duplicate";

export interface FreshnessHistoryEntry {
  /** Stable id of the prior classified event we'd link a continuation to. */
  event_id: string;
  embedding: number[];
}

export interface FreshnessInput {
  new_embedding: number[];
  history: FreshnessHistoryEntry[];
  /** Optional per-call override (e.g. when a sentence-transformer is
   *  active and tighter thresholds apply). Defaults are BoW-tuned. */
  thresholds?: { duplicate: number; continuation: number };
}

export interface FreshnessResult {
  verdict: FreshnessVerdict;
  /** Best-matching prior event id (when verdict !== 'novel'). */
  matched_event_id: string | null;
  similarity: number;
  thresholds: { duplicate: number; continuation: number };
}

/** Defaults tuned for the BoW pseudo-embedding (`localTextEmbed`).
 *  Override at call site when a sentence-transformer is plugged in. */
const DUPLICATE_THRESHOLD = 0.55;
const CONTINUATION_THRESHOLD = 0.42;

/** Sentence-transformer-style thresholds for when a real semantic model
 *  is wired up via `setEmbeddingProvider`. Documented per the original
 *  task spec (0.85 / 0.75). */
export const SENTENCE_TRANSFORMER_THRESHOLDS = {
  duplicate: 0.85,
  continuation: 0.75,
} as const;

/**
 * Compare a new article against recent history. Returns the highest-
 * similarity match and the verdict for it. Pure: no I/O, no time, no
 * randomness — easy to test with synthetic embeddings.
 */
export function classifyFreshness(input: FreshnessInput): FreshnessResult {
  const thresholds = input.thresholds ?? {
    duplicate: DUPLICATE_THRESHOLD,
    continuation: CONTINUATION_THRESHOLD,
  };

  let maxSim = 0;
  let matched: string | null = null;
  for (const h of input.history) {
    const sim = cosineSimilarity(input.new_embedding, h.embedding);
    if (sim > maxSim) {
      maxSim = sim;
      matched = h.event_id;
    }
  }

  if (maxSim > thresholds.duplicate) {
    return {
      verdict: "duplicate",
      matched_event_id: matched,
      similarity: maxSim,
      thresholds,
    };
  }
  if (maxSim >= thresholds.continuation) {
    return {
      verdict: "continuation",
      matched_event_id: matched,
      similarity: maxSim,
      thresholds,
    };
  }
  return {
    verdict: "novel",
    matched_event_id: null,
    similarity: maxSim,
    thresholds,
  };
}

export const FRESHNESS_THRESHOLDS = {
  duplicate: DUPLICATE_THRESHOLD,
  continuation: CONTINUATION_THRESHOLD,
} as const;
