/**
 * Stage 6 — Relevance-weighted conflict detection.
 *
 * Two signals on the same asset with opposite directions are only a
 * REAL conflict if both signals treat that asset as a primary subject
 * (or directly affected named entity). If one of them merely mentions
 * the asset incidentally, it's `related_context` — interesting to flag
 * but not a contradiction the user has to resolve.
 *
 * Real example caught in May 2026:
 *   - Signal A: "Arbitrum DAO governance vote" → ARB LONG, ARB is SUBJECT (1.0)
 *   - Signal B: "LayerZero systemic vulnerability" → ARB SHORT, ARB is
 *               INCIDENTALLY MENTIONED (0.3) because ARB happens to use
 *               LayerZero, but the article is about LayerZero.
 *   - Old detector: flagged as CONFLICT (wrong — different stories).
 *   - New detector: `related_context` (right — surface in audit, don't block).
 */

import {
  CONFLICT_RELEVANCE_THRESHOLD,
  type ConflictKind,
  type ConflictReport,
} from "./types";

export interface ConflictSignal {
  asset_id: string;
  direction: "long" | "short";
  conviction: number;
  /** Numeric relevance score in [0, 1]. */
  asset_relevance: number;
}

export function computeConflict(
  a: ConflictSignal,
  b: ConflictSignal,
): ConflictReport {
  if (a.asset_id !== b.asset_id) {
    return {
      kind: "no_overlap" as ConflictKind,
      reason: "different assets",
      net_long_conviction: 0,
      net_short_conviction: 0,
    };
  }
  if (a.direction === b.direction) {
    return {
      kind: "no_overlap",
      reason: "same direction",
      net_long_conviction:
        a.direction === "long" ? a.conviction + b.conviction : 0,
      net_short_conviction:
        a.direction === "short" ? a.conviction + b.conviction : 0,
    };
  }

  const long = a.direction === "long" ? a : b;
  const short = a.direction === "short" ? a : b;

  // Both must clear the relevance threshold for a true conflict.
  if (
    long.asset_relevance >= CONFLICT_RELEVANCE_THRESHOLD &&
    short.asset_relevance >= CONFLICT_RELEVANCE_THRESHOLD
  ) {
    return {
      kind: "conflict",
      reason: `both signals treat ${a.asset_id} as subject (relevance ${long.asset_relevance.toFixed(1)} / ${short.asset_relevance.toFixed(1)})`,
      net_long_conviction: long.conviction,
      net_short_conviction: short.conviction,
    };
  }

  return {
    kind: "related_context",
    reason: `at least one signal mentions ${a.asset_id} only incidentally (relevance ${long.asset_relevance.toFixed(1)} / ${short.asset_relevance.toFixed(1)})`,
    net_long_conviction: long.conviction,
    net_short_conviction: short.conviction,
  };
}
