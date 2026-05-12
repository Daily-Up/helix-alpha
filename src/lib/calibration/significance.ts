/**
 * Stage 2b — Significance scoring (Phase C, invariant I-41).
 *
 * Sits between classification (Stage 2) and asset routing (Stage 3).
 * Inputs: classifier output (subtype, asset_class, asset_relevance,
 * headline text). Output: a single score in [0,1] that determines
 * whether a signal should ever exist for this headline and at what tier.
 *
 * Score = 0.5 × magnitude_component
 *       + 0.3 × instance_strength_component
 *       + 0.2 × novelty_component
 *
 * Tier thresholds:
 *   ≥ 0.75 → auto
 *   0.50–0.75 → review
 *   0.25–0.50 → info
 *   < 0.25 → drop (never persists as a signal; recorded in dropped_headlines)
 *
 * Conviction still influences sizing within a tier; significance determines
 * the tier. Per spec: "These replace the current tier-from-conviction logic."
 *
 * Companion tests: tests/significance-scoring.test.ts
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { embed, cosineSimilarity } from "../pipeline/embeddings";
import {
  lookupDerivedRate,
  lookupWithFallback,
  type DerivedBaseRateTable,
} from "./derive-base-rates";
import { getBaseRate, type AssetClass } from "../pipeline/base-rates";

const BASE_RATES_PATH = join(process.cwd(), "data", "base-rates.json");

let _table: DerivedBaseRateTable | null = null;

/** Load and cache the empirical base-rate table. Server-only. */
export function loadBaseRates(): DerivedBaseRateTable {
  if (_table) return _table;
  if (!existsSync(BASE_RATES_PATH)) {
    throw new Error(
      `[significance] data/base-rates.json missing — run \`tsx scripts/calibrate-base-rates.ts\` first`,
    );
  }
  const raw = readFileSync(BASE_RATES_PATH, "utf-8");
  _table = JSON.parse(raw) as DerivedBaseRateTable;
  return _table;
}

/** Reset cached table. Test-only. */
export function _resetBaseRatesCache(): void {
  _table = null;
}

/** Inject a base-rates table directly (tests). */
export function _setBaseRatesTable(table: DerivedBaseRateTable | null): void {
  _table = table;
}

export type SignificanceTier = "auto" | "review" | "info" | "drop";

export interface SignificanceComponents {
  /** 50% — base-rate magnitude × asset relevance. */
  magnitude: number;
  /** 30% — how strong an instance of the subtype the headline is. */
  instance_strength: number;
  /** 20% — embedding novelty against recent similar signals. */
  novelty: number;
}

export interface SignificanceResult {
  score: number;
  tier: SignificanceTier;
  components: SignificanceComponents;
  reasoning: string;
  /** When we fell back to a sibling asset_class for the base rate. */
  base_rate_from_class: string | null;
}

export interface SignificanceInput {
  headline: string;
  subtype: string;
  asset_class: string;
  asset_relevance: number; // 0..1
  /** Recent similar signals' headlines for novelty comparison.
   *  Provide all `fired_at` within last 7 days for the same asset (or asset class). */
  recent_headlines?: string[];
}

/**
 * Asymptotic mapping from mean_move_pct to [0,1]. Half-saturation at 5%.
 *   5%   → 0.50
 *   12.5% → 0.71 (ETF approval band)
 *   25%  → 0.83
 *   100% → 0.95
 * Saturates so single huge corpus entries don't dominate forever.
 */
function magnitudeFromMean(meanPct: number): number {
  if (!Number.isFinite(meanPct) || meanPct <= 0) return 0;
  return meanPct / (meanPct + 5);
}

const MAGNITUDE_WEIGHT = 0.5;
const INSTANCE_WEIGHT = 0.3;
const NOVELTY_WEIGHT = 0.2;

const NOVELTY_SIMILARITY_THRESHOLD = 0.75;

// ─────────────────────────────────────────────────────────────────────────
// Component 2 — instance strength
// ─────────────────────────────────────────────────────────────────────────

const HEDGE_TERMS = [
  "rumor",
  "rumors",
  "rumored",
  "potential",
  "potentially",
  "could",
  "may",
  "might",
  "considering",
  "discussion",
  "discussions",
  "discussing",
  "expected to",
  "weighing",
  "exploring",
  "reportedly",
  "alleged",
  "allegedly",
  "speculation",
  "speculative",
  "possible",
  "possibly",
  "if approved",
  "in talks",
];

const STRONG_VERBS = [
  "approves",
  "approved",
  "rejects",
  "rejected",
  "fires",
  "fired",
  "drained",
  "drains",
  "hacked",
  "hacks",
  "exploits",
  "exploited",
  "buys",
  "sells",
  "sold",
  "purchased",
  "announces",
  "announced",
  "confirms",
  "confirmed",
  "launches",
  "launched",
  "raises",
  "raised",
  "lists",
  "listed",
  "delists",
  "delisted",
  "passed",
  "signed",
  "ruled",
  "wins",
  "won",
];

/**
 * Score how strong an instance of its subtype the headline is.
 *
 * Heuristic — penalize hedge language, reward strong factual verbs.
 * Range: [0.1, 1.0]. We never return 0 for component 2 because the
 * classifier-assigned subtype itself is information; the floor of 0.1
 * keeps a poorly-worded but classifier-trusted headline from being
 * zeroed by a single hedge word.
 */
export function scoreInstanceStrength(headline: string): {
  score: number;
  hits: string[];
  hedges: string[];
} {
  const t = headline.toLowerCase();
  const hedges = HEDGE_TERMS.filter((h) => t.includes(h));
  const hits = STRONG_VERBS.filter((v) => t.includes(v));
  // Start at 0.6 — neutral classifier-trusted headline.
  let s = 0.6;
  // Each strong verb adds 0.15, capped at 1.0.
  s += Math.min(0.4, hits.length * 0.15);
  // Each hedge term subtracts 0.18, floored at 0.1.
  s -= hedges.length * 0.18;
  s = Math.max(0.1, Math.min(1.0, s));
  return { score: s, hits, hedges };
}

// ─────────────────────────────────────────────────────────────────────────
// Component 3 — novelty (embedding similarity to recent signals)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Novelty score from a list of recent headlines.
 *   No similar → 1.0
 *   1 similar → 0.5
 *   2+ similar → 0.1
 *
 * "Similar" = cosine similarity ≥ NOVELTY_SIMILARITY_THRESHOLD (0.75).
 */
export function scoreNovelty(
  headline: string,
  recentHeadlines: string[],
): { score: number; similar_count: number } {
  if (recentHeadlines.length === 0) return { score: 1.0, similar_count: 0 };
  const target = embed(headline);
  let similarCount = 0;
  for (const r of recentHeadlines) {
    const v = embed(r);
    const sim = cosineSimilarity(target, v);
    if (sim >= NOVELTY_SIMILARITY_THRESHOLD) similarCount++;
  }
  if (similarCount === 0) return { score: 1.0, similar_count: 0 };
  if (similarCount === 1) return { score: 0.5, similar_count: 1 };
  return { score: 0.1, similar_count: similarCount };
}

// ─────────────────────────────────────────────────────────────────────────
// Tier assignment
// ─────────────────────────────────────────────────────────────────────────

export function tierForScore(score: number): SignificanceTier {
  if (score >= 0.75) return "auto";
  if (score >= 0.5) return "review";
  if (score >= 0.25) return "info";
  return "drop";
}

// ─────────────────────────────────────────────────────────────────────────
// Top-level scorer
// ─────────────────────────────────────────────────────────────────────────

/**
 * Score a candidate headline + classifier output. Returns the composite
 * score, the tier mapping, and the components used so callers can audit
 * exactly why a headline scored as it did (and surface this in
 * dropped_headlines.significance_reasoning).
 */
export function scoreSignificance(input: SignificanceInput): SignificanceResult {
  const table = loadBaseRates();
  const fb = lookupWithFallback(table, input.subtype, input.asset_class);

  let magnitude = 0;
  let fromClass: string | null = null;
  let rateMean: number | null = null;
  if (fb) {
    rateMean = fb.rate.mean_move_pct;
    const mag = magnitudeFromMean(fb.rate.mean_move_pct);
    magnitude = mag * clamp01(input.asset_relevance);
    fromClass = fb.from_class;
  } else {
    // Corpus is silent on this (subtype, asset_class). Fall back to the
    // legacy hand-curated table in src/lib/pipeline/base_rates.json.
    // This keeps existing pipeline coverage (transient_operational,
    // treasury_action, etc.) working at sensible significance even
    // though the empirical corpus doesn't include their subtypes yet.
    const legacy = getBaseRate(input.subtype, input.asset_class as AssetClass);
    if (legacy) {
      rateMean = legacy.mean_move_pct;
      const mag = magnitudeFromMean(legacy.mean_move_pct);
      magnitude = mag * clamp01(input.asset_relevance);
      fromClass = `${input.asset_class} (legacy)`;
    }
  }

  const instance = scoreInstanceStrength(input.headline);
  const novelty = scoreNovelty(input.headline, input.recent_headlines ?? []);

  const rawScore =
    MAGNITUDE_WEIGHT * magnitude +
    INSTANCE_WEIGHT * instance.score +
    NOVELTY_WEIGHT * novelty.score;

  // Magnitude gate — novelty + neutral instance language alone is not
  // enough to make an unsignificant catalyst significant. When the
  // (subtype × asset_class × relevance) magnitude component is small,
  // attenuate the overall score. The intuition: "BTC holds above $80K"
  // (subtype=other, relevance≈0.3) should drop even though it's a new
  // headline using factual language.
  // Multiplier rises from 0.4 at mag=0 to 1.0 at mag=0.15.
  const magnitudeGate = Math.min(1, 0.4 + magnitude * 4);
  const score = rawScore * magnitudeGate;

  const tier = tierForScore(score);

  const reasoning = buildReasoning({
    score,
    tier,
    magnitude,
    rate: rateMean,
    fromClass,
    relevance: input.asset_relevance,
    instance,
    novelty,
  });

  return {
    score: round3(score),
    tier,
    components: {
      magnitude: round3(magnitude),
      instance_strength: round3(instance.score),
      novelty: round3(novelty.score),
    },
    reasoning,
    base_rate_from_class: fromClass,
  };
}

function buildReasoning(p: {
  score: number;
  tier: SignificanceTier;
  magnitude: number;
  rate: number | null;
  fromClass: string | null;
  relevance: number;
  instance: { score: number; hits: string[]; hedges: string[] };
  novelty: { score: number; similar_count: number };
}): string {
  const parts: string[] = [];
  parts.push(`score=${round3(p.score)} → ${p.tier.toUpperCase()}`);
  if (p.rate != null) {
    parts.push(
      `magnitude=${round3(p.magnitude)} (rate ${p.rate.toFixed(1)}% × relev ${p.relevance.toFixed(2)}${p.fromClass ? ` from ${p.fromClass}` : ""})`,
    );
  } else {
    parts.push(`magnitude=0 (no base rate for subtype × asset_class)`);
  }
  parts.push(
    `instance=${round3(p.instance.score)}` +
      (p.instance.hits.length > 0 ? ` hits=[${p.instance.hits.join(",")}]` : "") +
      (p.instance.hedges.length > 0 ? ` hedges=[${p.instance.hedges.join(",")}]` : ""),
  );
  parts.push(
    `novelty=${round3(p.novelty.score)} (${p.novelty.similar_count} similar in window)`,
  );
  return parts.join("; ");
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
