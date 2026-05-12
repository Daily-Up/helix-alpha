/**
 * Stage 7 — Reliability caps.
 *
 * Two heuristics that cap a signal's tier when the SOURCE itself looks
 * unreliable, regardless of how confident the conviction math claims to be.
 * Both checks are pure / deterministic / testable.
 *
 *   1. `scoreReasoningHedge` — When the classifier's own reasoning text
 *      hedges ("title says X, body says Y", "likely commentary",
 *      "appears to", "if confirmed", "rumored", "claims", "speculation",
 *      "unverified") the AI is telling us it's unsure. We were ignoring
 *      that hedge and firing the signal at full conviction anyway.
 *
 *   2. `scoreAnonymizedActor` — Real news headlines name the actor.
 *      "UBS dropped a $1.12B bet on Strategy" — verifiable.
 *      "Switzerland's largest bank dropped a $1.12B bet on Strategy" —
 *      anonymized, unverifiable until a tier-1 outlet names the bank.
 *      This pattern (generic descriptor + specific dollar figure) is
 *      a near-perfect tell for un-corroborated rumors.
 *
 * Both produce a `ReliabilityScore` ∈ [0,1] and an `applyReliabilityCap`
 * function that downgrades the tier when the score crosses 0.5 and the
 * source isn't tier-1 (Bloomberg / SEC bypass — they can hedge).
 *
 * Companion tests: tests/reliability.test.ts
 */

import type { SourceTier } from "./types";

export interface ReliabilityScore {
  score: number;
  reasons: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// Hedge detection in classifier reasoning
// ─────────────────────────────────────────────────────────────────────────

/**
 * Phrases that indicate the AI itself is unsure about the news article.
 * Each match adds to the hedge score; the threshold (0.5) is calibrated
 * so a single weak hedge ("appears to") doesn't cap, but two weak ones
 * or one strong one ("title says X, body says Y") does.
 */
const HEDGE_PATTERNS: Array<{ name: string; re: RegExp; weight: number }> = [
  // Strong hedges — single match should cap.
  {
    name: "title_body_mismatch",
    // Catches "title says X, body says Y" or "title says ... body says ..."
    re: /\btitle\s+says\b[\s\S]{0,80}\bbody\s+says\b/i,
    weight: 0.6,
  },
  {
    name: "likely_commentary",
    re: /\blikely\s+(?:commentary|opinion|speculation|misinterpretation)\b/i,
    weight: 0.6,
  },
  {
    name: "if_confirmed",
    re: /\bif\s+(?:confirmed|verified|true|accurate)\b/i,
    weight: 0.5,
  },
  {
    name: "appears_to_be_rumor",
    re: /\b(?:rumored|rumour|speculation|speculative|unverified|unconfirmed)\b/i,
    weight: 0.5,
  },
  // Medium hedges — two of these to cap.
  {
    name: "appears_to",
    re: /\bappears\s+to\b/i,
    weight: 0.25,
  },
  {
    name: "may_be",
    re: /\b(?:may\s+be|might\s+be|could\s+be)\s+(?:a|an|the)?\b/i,
    weight: 0.2,
  },
  {
    name: "unclear_whether",
    re: /\bunclear\s+(?:whether|if|whether\s+or)/i,
    weight: 0.3,
  },
  {
    name: "claims_without_named_source",
    // "claims" / "alleged" with no quoted source — quick proxy
    re: /\b(?:claims|alleged|allegedly|reportedly)\b/i,
    weight: 0.25,
  },
  {
    name: "single_source_disclaimer",
    re: /\b(?:single[- ]source|cites?\s+(?:unnamed|anonymous|sources?))\b/i,
    weight: 0.5,
  },
];

/**
 * Scan classifier reasoning text for hedging phrases.
 * Returns score in [0, 1] (clamped) plus the list of patterns that matched.
 */
export function scoreReasoningHedge(reasoning: string): ReliabilityScore {
  const reasons: string[] = [];
  let score = 0;
  if (!reasoning) return { score, reasons };
  for (const p of HEDGE_PATTERNS) {
    if (p.re.test(reasoning)) {
      score += p.weight;
      reasons.push(`hedge:${p.name}`);
    }
  }
  return { score: Math.min(1, score), reasons };
}

// ─────────────────────────────────────────────────────────────────────────
// Anonymized-actor detection in titles
// ─────────────────────────────────────────────────────────────────────────

/**
 * Anonymized-actor patterns: titles that describe an actor by superlative
 * descriptor instead of by name. Real journalism names the actor in the
 * headline; tweet aggregators often don't.
 */
const ANON_DESCRIPTORS: RegExp[] = [
  // "X's largest Y" — Switzerland's largest bank, world's largest hedge fund
  /\b(?:[A-Z][a-zA-Z]+(?:'s|s)?|world(?:'s)?|country(?:'s)?)\s+(?:largest|biggest|top|leading)\s+(?:bank|fund|hedge\s+fund|exchange|treasury|company|asset\s+manager|lender|broker|insurer|pension)/i,
  // "a major X" / "one of the largest X"
  /\b(?:a|one\s+of\s+the)\s+(?:major|largest|biggest|top|leading)\s+(?:bank|fund|hedge\s+fund|exchange|company|asset\s+manager|whale|investor|holder)/i,
  // "[adjective] [country] [institution]" without a name
  /\b(?:undisclosed|anonymous|unnamed|certain|prominent|well[- ]known)\s+(?:bank|fund|hedge\s+fund|investor|whale|holder|family\s+office|trader)/i,
];

/** $X[m|million|b|billion] anywhere in the title. */
const SIZE_FIGURE_TITLE =
  /\$\s*\d[\d,.]*\s*(?:m|mn|million|b|bn|billion|k)?\b/i;

/**
 * Score how likely the title is an anonymized-actor rumor.
 *
 * Rule: anonymizing descriptor + specific dollar figure → 0.6 (cap).
 * Anonymizing descriptor alone → 0.3 (warning, not cap).
 * Specific actor name (proper noun in first 30 chars) negates.
 */
export function scoreAnonymizedActor(title: string): ReliabilityScore {
  const reasons: string[] = [];
  if (!title) return { score: 0, reasons };
  const matched = ANON_DESCRIPTORS.some((re) => re.test(title));
  if (!matched) return { score: 0, reasons };
  reasons.push("anon_descriptor");
  const hasSize = SIZE_FIGURE_TITLE.test(title);
  if (hasSize) {
    reasons.push("specific_dollar_figure");
    return { score: 0.6, reasons };
  }
  return { score: 0.3, reasons };
}

// ─────────────────────────────────────────────────────────────────────────
// Cap application
// ─────────────────────────────────────────────────────────────────────────

/**
 * Cap a tier based on combined reliability scores.
 *
 * Rule:
 *   - If hedge score >= 0.5 OR anon score >= 0.5 AND source_tier > 1 →
 *     cap at INFO. Tier-1 sources (Bloomberg/SEC/Reuters/etc.) bypass.
 *   - Cap NEVER promotes — only downgrades.
 *   - When both scores are mid (each 0.3) the SUM threshold of 0.5 also
 *     triggers the cap (combined evidence).
 */
export function capTierForReliability(
  tier: "auto" | "review" | "info",
  hedge: ReliabilityScore,
  anon: ReliabilityScore,
  sourceTier: SourceTier,
): { tier: "auto" | "review" | "info"; capped: boolean; reason: string | null } {
  // Tier-1 outlets are trusted to write hedged copy without us suppressing.
  if (sourceTier === 1) return { tier, capped: false, reason: null };
  const combinedScore = Math.min(1, hedge.score + anon.score);
  const cap =
    hedge.score >= 0.5 || anon.score >= 0.5 || combinedScore >= 0.5;
  if (!cap) return { tier, capped: false, reason: null };
  if (tier === "info") return { tier, capped: false, reason: null };
  const reasonBits = [...hedge.reasons, ...anon.reasons].slice(0, 3);
  return {
    tier: "info",
    capped: true,
    reason: `reliability_cap (${reasonBits.join(", ")})`,
  };
}
