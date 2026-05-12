/**
 * Signal generator — turns classified events into tiered, tradable signals.
 *
 * For each event×asset pair where:
 *   • the event has a Claude classification
 *   • the asset has a SoDEX trading pair (tradable)
 *   • we haven't already generated a signal for this pair
 *
 * we compute:
 *   • direction (long for positive sentiment, short for negative)
 *   • confidence (Claude's classification.confidence — refined later by
 *     pattern matching once we have enough impact data)
 *   • tier (auto / review / info based on user thresholds)
 *   • suggested size + stop + target from settings + heuristics
 *
 * Idempotent: skips event×asset pairs that already have a signal.
 */

import { randomUUID } from "node:crypto";
import {
  Assets,
  Cron,
  Settings,
  Signals,
  Outcomes,
  type Classification,
  type EventType,
} from "@/lib/db";
import { db, transaction } from "@/lib/db";

// ── Pipeline modules — single source of truth for stage-by-stage contracts ──
// Each is independently tested in tests/*.test.ts and documented in
// PIPELINE_INVARIANTS.md. Wiring them here replaces older inline heuristics
// (isDigestArticle, KIND_PRIORITY sort, RISK_BY_TYPE) with deterministic,
// auditable checks. The legacy inline functions are kept as defense-in-depth
// fallbacks but the pipeline modules are authoritative for new metadata
// (catalyst_subtype, expires_at, asset_relevance, promotional_score, etc.).
import { detectDigest } from "@/lib/pipeline/digest";
import {
  scorePromotional,
  capTierForPromotional,
} from "@/lib/pipeline/promotional";
import { routeAssets, scoreAssetRelevance } from "@/lib/pipeline/asset-router";
import {
  inferCatalystSubtype,
  riskProfileForSubtype,
  capForFundingMagnitude,
} from "@/lib/pipeline/catalyst-subtype";
import {
  classifyAssetClass,
  getBaseRate,
  riskFromBaseRate,
  horizonHoursToString,
  shouldCapConvictionFromBaseRate,
} from "@/lib/pipeline/base-rates";
import {
  computeRealizedFraction,
  applyRealizedMoveCap,
} from "@/lib/pipeline/price-realization";
import { computeLifecycle } from "@/lib/pipeline/lifecycle";
import {
  deriveEventChainId,
  adjustConvictionForHistory,
  type PriorSignalRecord,
} from "@/lib/pipeline/entity-history";
import {
  checkSignalInvariants,
  type PreSaveSignal,
} from "@/lib/pipeline/invariants";
import {
  scoreReasoningHedge,
  scoreAnonymizedActor,
  capTierForReliability,
} from "@/lib/pipeline/reliability";
import {
  ASSET_RELEVANCE_SCORE,
  type AssetRelevanceLevel,
  type SourceTier,
} from "@/lib/pipeline/types";
import { scoreSignificance } from "@/lib/calibration/significance";
import { recentHeadlinesForAsset } from "@/lib/calibration/recent-headlines";
import { insertDroppedHeadline } from "@/lib/db/repos/dropped-headlines";
import {
  resolveConflict,
  type ConflictCandidate,
} from "@/lib/calibration/conflicts";
import {
  insertSuppressedSignal,
  insertSupersession,
} from "@/lib/db/repos/conflicts";
import {
  checkDirectionLock,
  DIRECTION_LOCK_CONVICTION_CAP,
} from "@/lib/calibration/direction-lock";

/** Convert a relevance level label into its numeric score [0..1]. */
function relevanceScoreFromLevel(level: AssetRelevanceLevel): number {
  return ASSET_RELEVANCE_SCORE[level];
}

/**
 * Map a numeric source-tier score (0..1, from `sourceTierScore`) to the
 * coarse tier-1/2/3 bucket the pipeline modules use. Bloomberg/SEC = 1,
 * known aggregators (PANews/Decrypt/CoinDesk) = 2, anon CT = 3.
 */
function classifySourceTier(scoreOrAuthor: {
  is_blue_verified: number | null;
  author: string | null;
}): SourceTier {
  const a = (scoreOrAuthor.author ?? "").toLowerCase();
  const tier1 = ["bloomberg", "reuters", "wsj", "ft.com", "coinbase", "sec.gov"];
  if (tier1.some((t) => a.includes(t))) return 1;
  const tier2 = [
    "panews", "chaincatcher", "decrypt", "decrpt", "foresightnews",
    "theblock", "coindesk", "cointelegraph", "unchained", "techflow",
    "odaily", "benzinga",
  ];
  if (tier2.some((t) => a.includes(t))) return 2;
  if (scoreOrAuthor.is_blue_verified === 1) return 2;
  return 3;
}

/** Pull recent signals on an asset (last 7d) for entity-history adjustment. */
function recentHistoryForAsset(assetId: string): PriorSignalRecord[] {
  const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
  const since = Date.now() - SEVEN_DAYS_MS;
  interface Row {
    asset_id: string;
    direction: "long" | "short";
    confidence: number;
    fired_at: number;
    event_chain_id: string | null;
  }
  return db()
    .prepare<[string, number], Row>(
      `SELECT asset_id, direction, confidence, fired_at, event_chain_id
       FROM signals
       WHERE asset_id = ? AND fired_at >= ?
         AND status IN ('pending', 'executed')`,
    )
    .all(assetId, since)
    .map((r) => ({
      asset_id: r.asset_id,
      direction: r.direction,
      conviction: r.confidence,
      fired_at: r.fired_at,
      event_chain_id: r.event_chain_id,
    }));
}

// ─────────────────────────────────────────────────────────────────────────
// Direction inference — SENTIMENT FIRST.
//
// HISTORY: v1 had a DIRECTION_BY_TYPE map that hardcoded a direction per
// event_type (regulatory→short, partnership→long, etc.) and ran BEFORE
// the sentiment check. That broke roughly half the world:
//   - Pro-crypto SEC statement → classified positive → forced SHORT
//     because "regulatory" was hardcoded short.
//   - Partnership breakdown → classified negative → forced LONG because
//     "partnership" was hardcoded long.
//
// The fix: sentiment IS the direction. The classifier already evaluates
// market interpretation (positive/negative/neutral) per the v5 prompt
// rules — there's no reason to second-guess it with a static map.
//
// We keep ONE narrow fallback: when sentiment is "neutral" AND the event
// has a near-mechanical direction (exploit drains funds, hack steals
// tokens), default to short. Everything else with neutral sentiment
// produces NO signal — neutrality is information.
// ─────────────────────────────────────────────────────────────────────────

/** Tiny fallback for cases where sentiment is "neutral" but the event
 *  type itself has near-mechanical price implications. Used ONLY when
 *  sentiment couldn't decide. Sentiment-positive/negative ALWAYS wins. */
const NEUTRAL_SENTIMENT_FALLBACK: Partial<
  Record<EventType, "long" | "short">
> = {
  // Exploits/hacks drain funds from a specific protocol — even if the
  // classifier flagged neutral (e.g. unclear scale), the mechanics are
  // bearish for the affected token.
  exploit: "short",
};

/**
 * Direction inference. ONLY uses sentiment, with a tiny neutral fallback
 * for mechanically-bearish event types. Returns null when no clear
 * direction can be derived — caller skips signal generation.
 */
function inferDirection(c: Classification): "long" | "short" | null {
  if (c.sentiment === "positive") return "long";
  if (c.sentiment === "negative") return "short";
  // sentiment === "neutral" — try the narrow fallback table.
  return NEUTRAL_SENTIMENT_FALLBACK[c.event_type] ?? null;
}

/**
 * Tradability score per event_type — how often this category actually
 * produces a profitable directional trade.
 *
 * Multiplied with classification confidence + severity weight to get
 * the real "trade conviction" used for tier resolution.
 *
 * Calibrated from intuition + general crypto market behavior. Will be
 * re-derived empirically from impact_metrics once we have enough samples.
 */
const TRADABILITY_BY_TYPE: Record<EventType, number> = {
  exploit:         0.95,  // drained funds → almost guaranteed move
  listing:         0.90,  // exchange listing reliably pumps
  regulatory:      0.80,  // SEC/CFTC actions move markets
  etf_flow:        0.75,  // real institutional money
  earnings:        0.70,  // quarterly catalyst
  treasury:        0.70,  // MSTR-style corporate buys move price
  social_platform: 0.60,  // platform actions (Kaito-X case)
  unlock:          0.55,  // predictable sell pressure
  airdrop:         0.50,  // often priced in
  macro:           0.50,  // depends on print direction
  tech_update:     0.40,  // upgrades often pre-announced
  security:        0.40,  // patches usually neutral
  partnership:     0.40,  // often hype with no follow-through
  fundraising:     0.35,  // long-term, slow to play out
  narrative:       0.25,  // subjective sentiment swings
  governance:      0.20,  // rarely moves spot price
  other:           0.10,
};

const SEVERITY_MULTIPLIER: Record<"high" | "medium" | "low", number> = {
  high:   1.0,
  medium: 0.7,
  low:    0.4,
};

// ─────────────────────────────────────────────────────────────────────────
// Per-event-type risk profiles.
//
// Different event categories have radically different volatility windows:
//   - Exploits resolve in hours (price-discovery is fast).
//   - Regulatory statements ripple over multiple days.
//   - Macro prints (CPI/FOMC) play out across a week as positioning shifts.
//   - Governance votes have a hard expiry at the vote time.
//
// Hardcoding 24h/-8%/+18% for every signal ignored this entirely. The
// values below are calibrated against the typical intraday move and
// historical hold for each category. Stops are TIGHTER on fast-decision
// events (exploits, listings) and WIDER on slow-burn ones (regulatory,
// macro). Targets follow the same logic.
//
// These are STARTING points; the asset's 30d realized vol then scales
// the stop within ±50% — see `riskProfileForSignal()` below.
// ─────────────────────────────────────────────────────────────────────────
interface RiskProfile {
  /** Stop loss as positive % distance from entry. */
  stop_pct: number;
  /** Take profit as positive % distance from entry. */
  target_pct: number;
  /** Expected position duration label. */
  horizon: string;
}

const RISK_BY_TYPE: Record<EventType, RiskProfile> = {
  exploit:         { stop_pct: 4,  target_pct: 12, horizon: "4h"  },
  regulatory:      { stop_pct: 6,  target_pct: 14, horizon: "3d"  },
  etf_flow:        { stop_pct: 5,  target_pct: 10, horizon: "2d"  },
  partnership:     { stop_pct: 8,  target_pct: 18, horizon: "24h" },
  listing:         { stop_pct: 6,  target_pct: 20, horizon: "12h" },
  social_platform: { stop_pct: 8,  target_pct: 15, horizon: "24h" },
  unlock:          { stop_pct: 5,  target_pct: 12, horizon: "48h" },
  airdrop:         { stop_pct: 10, target_pct: 25, horizon: "3d"  },
  earnings:        { stop_pct: 6,  target_pct: 14, horizon: "3d"  },
  macro:           { stop_pct: 4,  target_pct: 9,  horizon: "5d"  },
  treasury:        { stop_pct: 7,  target_pct: 16, horizon: "3d"  },
  governance:      { stop_pct: 8,  target_pct: 15, horizon: "24h" },
  tech_update:     { stop_pct: 7,  target_pct: 18, horizon: "5d"  },
  security:        { stop_pct: 5,  target_pct: 10, horizon: "24h" },
  narrative:       { stop_pct: 8,  target_pct: 18, horizon: "3d"  },
  fundraising:     { stop_pct: 8,  target_pct: 20, horizon: "5d"  },
  other:           { stop_pct: 8,  target_pct: 18, horizon: "24h" },
};

/**
 * Resolve risk parameters for a signal — combining event_type defaults
 * with the asset's recent realized volatility. Without vol data we use
 * the type defaults verbatim.
 *
 * Vol-scaling: assets with realized 30d vol >75% (e.g. small-cap alts)
 * get stops widened by 30%; vol <25% (e.g. stablecoin pairs that
 * shouldn't be here anyway) get stops tightened by 30%.
 */
function riskProfileForSignal(
  eventType: EventType,
  vol30d: number | null,
): RiskProfile {
  const base = RISK_BY_TYPE[eventType] ?? RISK_BY_TYPE.other;
  if (vol30d == null || !Number.isFinite(vol30d)) return base;
  // vol30d is annualized realized vol as a fraction (0.30 = 30%).
  let scale = 1.0;
  if (vol30d > 0.75) scale = 1.3;
  else if (vol30d < 0.25) scale = 0.7;
  return {
    stop_pct: Math.round(base.stop_pct * scale * 10) / 10,
    target_pct: Math.round(base.target_pct * scale * 10) / 10,
    horizon: base.horizon,
  };
}

/**
 * Compute realized vol from the last 30 days of daily klines.
 * Returns annualized stddev of log returns, or null when we don't
 * have enough history. Cheap to call — caller should cache per asset.
 */
function realizedVol30d(assetId: string): number | null {
  interface Row {
    close: number;
  }
  const rows = db()
    .prepare<[string], Row>(
      `SELECT close FROM klines_daily
       WHERE asset_id = ?
       ORDER BY date DESC LIMIT 31`,
    )
    .all(assetId);
  if (rows.length < 10) return null;
  const closes = rows.map((r) => r.close).reverse();
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 5) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance =
    rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length;
  // Annualize: daily stddev × sqrt(365)
  return Math.sqrt(variance) * Math.sqrt(365);
}

/**
 * Daily close on or before the given timestamp. Used by Dimension 2
 * (price-already-moved) to compare catalyst-publish-time price vs now.
 * Returns null if no kline exists for the lookback (e.g. asset isn't
 * priceable in our klines_daily table) — caller skips the check.
 */
function priceAtOrBefore(assetId: string, ts: number): number | null {
  const date = new Date(ts).toISOString().slice(0, 10);
  const r = db()
    .prepare<[string, string], { close: number }>(
      `SELECT close FROM klines_daily
       WHERE asset_id = ? AND date <= ?
       ORDER BY date DESC LIMIT 1`,
    )
    .get(assetId, date);
  return r && r.close > 0 ? r.close : null;
}

/** Parse "4h", "24h", "3d", "5d" → hours; null on unrecognized format.
 *  Used to record horizon_hours on blocked outcomes (where we don't have
 *  a complete signals row to read horizon_hours from). */
function riskV2_horizon_hours_from_string(s: string): number | null {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)([hd])$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2].toLowerCase() === "d" ? Math.round(n * 24) : Math.round(n);
}

/** Most recent kline close. Standin for "current price" for D2 — we
 *  fall back to klines instead of the live SoDEX feed because (a) the
 *  feed is async and signal-gen is sync, and (b) klines are the same
 *  source the catalyst price came from, so the comparison is consistent. */
function mostRecentClose(assetId: string): number | null {
  const r = db()
    .prepare<[string], { close: number }>(
      `SELECT close FROM klines_daily
       WHERE asset_id = ?
       ORDER BY date DESC LIMIT 1`,
    )
    .get(assetId);
  return r && r.close > 0 ? r.close : null;
}

/**
 * True trade conviction in [0, 1]:
 *
 *   conviction = classification_confidence × tradability × severity
 *
 * Example calibrations:
 *   exploit/high/0.85       → 0.85 × 0.95 × 1.0 = 0.81  (review)
 *   listing/high/0.90       → 0.90 × 0.90 × 1.0 = 0.81  (review)
 *   etf_flow/high/0.95      → 0.95 × 0.75 × 1.0 = 0.71  (review)
 *   governance/medium/0.85  → 0.85 × 0.20 × 0.7 = 0.12  (info)
 *   partnership/medium/0.75 → 0.75 × 0.40 × 0.7 = 0.21  (info)
 *   narrative/low/0.50      → 0.50 × 0.25 × 0.4 = 0.05  (skipped)
 */
/**
 * Cache of empirical tradability scores keyed by `${event_type}|${sentiment}`.
 * Set by runSignalGen at start. Allows the signal generator to ADJUST
 * hardcoded TRADABILITY_BY_TYPE based on actual measured outcomes —
 * but bounded to [0.5×, 1.2×] of the hardcoded baseline so noisy
 * backfilled data can't destroy valid signal categories.
 *
 * Why bounded: in v1 the empirical score completely replaced hardcoded
 * (e.g. earnings dropped from 0.70 → 0.082), so legitimate $394M-miss
 * signals fell below the conviction threshold and silently disappeared.
 * The bound treats empirical as a CALIBRATION input, not an override.
 */
let _empiricalCache: Map<string, number | null> | null = null;

/** Resolve tradability for an (event_type, sentiment) pair.
 *  Returns hardcoded score adjusted by empirical evidence within bounds. */
function resolveTradability(
  eventType: EventType,
  sentiment: "positive" | "negative" | "neutral",
): {
  score: number;
  source: "empirical_bounded" | "hardcoded";
} {
  const hardcoded = TRADABILITY_BY_TYPE[eventType] ?? 0.1;
  const emp = _empiricalCache?.get(`${eventType}|${sentiment}`);
  if (emp == null) {
    return { score: hardcoded, source: "hardcoded" };
  }
  // Bound empirical to [0.5×, 1.2×] of hardcoded. Empirical can flag
  // an event_type as less or more reliable than expected, but can't
  // single-handedly decide it's untradeable — the hardcoded baseline
  // represents intuition that took years of crypto trading to build.
  const bounded = Math.max(hardcoded * 0.5, Math.min(hardcoded * 1.2, emp));
  return { score: bounded, source: "empirical_bounded" };
}

/**
 * Conviction breakdown — one weighted sum across orthogonal axes
 * instead of a single multiplicative formula.
 *
 * The original formula `confidence × tradability × severity` produced
 * a narrow output band (everything clustered at 30-40%) because the
 * three inputs themselves cluster at common values: LLM confidence ~0.85,
 * tradability ~0.4-0.7, severity 0.7. Multiplied together → ~0.24.
 *
 * The weighted sum lets each axis contribute independently and naturally
 * stretches the output across [0, 1]. Each component is tracked so the
 * final reasoning string can show the user EXACTLY why a signal scored
 * high or low.
 *
 * Axes (weights sum to 1.0):
 *   classifier_confidence (0.25) — Claude's own confidence in the call
 *   tradability           (0.20) — historical reliability of this event_type
 *   severity              (0.15) — magnitude bucket
 *   source_tier           (0.12) — Bloomberg vs anon Twitter
 *   polarity_clarity      (0.10) — sentiment-driven vs neutral fallback
 *   event_type_weight     (0.10) — some categories are inherently bigger
 *   novelty               (0.08) — fresh vs already-priced-in
 */
interface ConvictionAxes {
  classifier_confidence: number;
  tradability: number;
  severity: number;
  source_tier: number;
  polarity_clarity: number;
  event_type_weight: number;
  novelty: number;
  /** Final weighted conviction in [0, 1]. */
  total: number;
}

const AXIS_WEIGHTS = {
  classifier_confidence: 0.25,
  tradability: 0.20,
  severity: 0.15,
  source_tier: 0.12,
  polarity_clarity: 0.10,
  event_type_weight: 0.10,
  novelty: 0.08,
} as const;

/** Inherent "movement potential" per event_type. Distinct from
 *  tradability (which is calibration data). This is "all else equal,
 *  how much does this category typically move price?" */
const EVENT_TYPE_WEIGHT: Record<EventType, number> = {
  exploit:         1.00, // hacks always move price hard
  listing:         0.85,
  regulatory:      0.85,
  earnings:        0.85,
  etf_flow:        0.75,
  treasury:        0.70,
  macro:           0.65,
  social_platform: 0.60,
  unlock:          0.55,
  airdrop:         0.50,
  partnership:     0.45,
  fundraising:     0.40,
  tech_update:     0.40,
  security:        0.35,
  governance:      0.30,
  narrative:       0.30,
  other:           0.20,
};

/**
 * Source tier from a news_events row. Heuristic — we don't have an
 * explicit publisher tier so we infer from `is_blue_verified` and a
 * known-aggregator allowlist. Returns [0..1].
 */
function sourceTierScore(
  isBlueVerified: number | null,
  author: string | null,
): number {
  const a = (author ?? "").toLowerCase();
  const knownTier1 = ["bloomberg", "reuters", "wsj", "ft.com", "coinbase", "sec.gov"];
  const knownTier2 = [
    "panews", "chaincatcher", "decrypt", "decrpt", "foresightnews",
    "theblock", "coindesk", "cointelegraph", "unchained", "techflow",
    "odaily", "benzinga",
  ];
  if (knownTier1.some((t) => a.includes(t))) return 0.95;
  if (knownTier2.some((t) => a.includes(t))) return 0.75;
  if (isBlueVerified === 1) return 0.65;
  return 0.45;
}

/**
 * Detect proxy-routing hallucinations on listing events.
 *
 * Real example: "Upbit will list Pharos (PROS) for spot trading on May
 * 8th at 20:30." — the classifier output `affected_asset_ids: ["tok-btc",
 * "idx-ssirwa"]` because PROS isn't in the tradable universe. Result:
 * a BTC LONG signal fires on a story that has zero relevance to BTC.
 *
 * The cleanest fix: parse the title to identify which token is actually
 * being LISTED. If the primary asset of the proposed signal doesn't
 * match the listed token (e.g. signal on tok-btc but the listing is
 * for PROS), refuse to fire. The classifier may still be confused, but
 * the gate is deterministic.
 *
 * Returns:
 *   - the symbol being listed when we can identify it
 *   - null when the title doesn't match a known listing pattern (in
 *     which case we don't second-guess the classifier).
 */
function extractListedTokenSymbol(title: string): string | null {
  if (!title) return null;
  const t = title.trim();
  // Pattern A: "list X" or "list the X (SYMBOL)" or "launch X"
  // Captures: 1=word-form name, 2=parenthesized SYMBOL (preferred).
  // Case-insensitive — handles "List" / "LIST" / "list" interchangeably.
  const reA =
    /\b(?:will\s+)?(?:list|lists|listed|listing|launch(?:es|ed|ing)?|add(?:s|ed|ing)?|enable(?:s|d|ing)?|to\s+list)\s+(?:the\s+)?([A-Za-z][a-zA-Z0-9]{0,15})(?:\s*\(([A-Z][A-Z0-9]{0,9})\))?/i;
  const a = t.match(reA);
  if (a) return (a[2] ?? a[1]).toUpperCase();
  // Pattern B: "X listing" / "X listed on Y"
  const b = t.match(
    /\b([A-Za-z][a-zA-Z0-9]{0,15})\s+(?:listing|listed|gets\s+listed|now\s+listed)/i,
  );
  if (b) return b[1].toUpperCase();
  // Pattern C: "$SYMBOL listed" / "$SYMBOL listing"
  const c = t.match(/\$([A-Z][A-Z0-9]{0,9})\s+(?:listing|listed|now\s+live)/i);
  if (c) return c[1].toUpperCase();
  return null;
}

/** Common quote currencies that almost never ARE the listed asset.
 *  Used as a backstop: if a listing signal proposes one of these as
 *  primary, we treat it as a proxy hallucination unless the listed
 *  token matches. */
const QUOTE_CURRENCY_SYMBOLS = new Set([
  "BTC", "ETH", "USDT", "USDC", "USD", "BNB", "SOL", "XRP",
]);

/**
 * Returns true when this listing-event signal is suspected to be a
 * proxy hallucination (PROS-listing-fires-BTC-LONG bug). Caller drops
 * the signal entirely.
 */
function isProxyHallucinatedListing(
  eventType: EventType,
  primaryAssetSymbol: string,
  title: string,
): boolean {
  if (eventType !== "listing") return false;
  const sym = primaryAssetSymbol.toUpperCase();
  // Only second-guess when the primary is a major quote currency.
  // Genuine BTC listings (e.g. "first BTC perp on X") are rare but real
  // — those titles would explicitly name BTC as the subject, which the
  // listed-token extractor catches below.
  if (!QUOTE_CURRENCY_SYMBOLS.has(sym)) return false;
  const listed = extractListedTokenSymbol(title);
  if (!listed) {
    // Couldn't parse the listed token — be conservative, only block if
    // the title also references quote-pair syntax. If the primary IS
    // a quote currency and the title shows pair syntax like "in KRW,
    // BTC, and USDT trading pairs", that's the hallmark of the bug.
    const looksLikePairListing = /\b(?:KRW|USDT|USDC|USD|BTC)\s*,?\s*(?:and|&|,)/i.test(
      title,
    );
    return looksLikePairListing;
  }
  // We extracted the listed token. If it isn't the primary, this is
  // definitely a proxy hallucination.
  return listed !== sym;
}

/**
 * GENERAL proxy-hallucination detector — applies to ANY ticker-specific
 * event where the classifier might have routed the signal to a major
 * asset as a "broad correlation proxy".
 *
 * Real example beyond listings: "ETHSecurity (TG group) incentive
 * dispute - #LayerZero security questioned again" — the classifier
 * stuffed `tok-btc` and `tok-eth` into affected_asset_ids because ZRO
 * isn't tradable, so the signal generator fired BTC SHORT on a
 * LayerZero-specific story. Same family of bug, different event_type.
 *
 * Rule: for event_types that are SUBJECT-SPECIFIC (security, exploit,
 * listing, partnership, governance, tech_update, fundraising), if the
 * primary is one of BTC/ETH/SOL/BNB/XRP/USDT/USDC AND the title
 * doesn't substantively name that asset, it's a proxy hallucination.
 *
 * For BROAD event_types (regulatory, macro, etf_flow, narrative,
 * earnings, treasury) we don't apply this — those can legitimately
 * affect BTC/ETH without the title naming them (e.g. "Fed dovish
 * surprise" is bullish for BTC even if BTC isn't in the title).
 */
const SUBJECT_SPECIFIC_EVENT_TYPES = new Set<EventType>([
  "security",
  "exploit",
  "listing",
  "partnership",
  "governance",
  "tech_update",
  "fundraising",
  "social_platform",
  "unlock",
  "airdrop",
]);

/** Plain-English names for majors so we can match titles that say
 *  "Bitcoin" / "Ethereum" rather than the ticker. */
const MAJOR_ASSET_NAMES: Record<string, string[]> = {
  BTC: ["btc", "bitcoin"],
  ETH: ["eth", "ether", "ethereum"],
  SOL: ["sol", "solana"],
  BNB: ["bnb", "binance coin"],
  XRP: ["xrp", "ripple"],
  USDT: ["usdt", "tether"],
  USDC: ["usdc", "circle"],
};

/**
 * Detect digest/roundup articles that bundle multiple unrelated events.
 *
 * Real example: "Crypto One Liners... DIVERSIFIED CRYPTO GLXY — Galaxy
 * Digital 1W: +24.2%, Strong Q1 beat... Circle earnings May 11, BitGo
 * May 13... COIN job cuts and MARA's M&A..." — five different events
 * bundled into one CRCL LONG signal. The classifier should split these,
 * but in practice it scores the bundle as one bullish event.
 *
 * The fix: refuse signals on titles matching known digest patterns.
 * Better to drop a few legitimate signals than to fire on bundled noise.
 */
function isDigestArticle(title: string): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  // Common digest/roundup signatures.
  return /\b(crypto\s+one\s+liners?|one\s+liners?|daily\s+wrap|weekly\s+wrap|daily\s+digest|weekly\s+digest|daily\s+newsletter|daily\s+roundup|weekly\s+roundup|news\s+digest|news\s+roundup|today\s+in\s+crypto|crypto\s+briefing|morning\s+brief|evening\s+brief|recap[:|]|wrap[:|]|crypto\s+wrap)\b/i.test(
    t,
  );
}

function isProxyHallucinatedGeneral(
  eventType: EventType,
  primaryAssetSymbol: string,
  title: string,
  content: string | null,
): boolean {
  if (!SUBJECT_SPECIFIC_EVENT_TYPES.has(eventType)) return false;
  const sym = primaryAssetSymbol.toUpperCase();
  const aliases = MAJOR_ASSET_NAMES[sym];
  if (!aliases) return false; // not a major, no proxy concern
  // Build a haystack from title + first 400 chars of body.
  const haystack = (title + " " + (content ?? "").slice(0, 400)).toLowerCase();
  // Look for the asset name as a STANDALONE word (not embedded — e.g.
  // "ETH" inside "ETHSecurity" doesn't count). Word-boundary match.
  for (const alias of aliases) {
    const re = new RegExp("\\b" + alias + "\\b", "i");
    if (re.test(haystack)) {
      // Asset is named in the article. NOT a proxy hallucination.
      // (Could still be a stretchy interpretation but at least the
      // article does talk about this asset.)
      return false;
    }
    // Also check the $TICKER pattern.
    if (haystack.includes("$" + alias)) return false;
  }
  // Asset is a major + event_type is subject-specific + asset isn't
  // named → proxy hallucination.
  return true;
}

/** Polarity clarity — high when sentiment is positive/negative,
 *  low when neutral (we shouldn't fire on neutral but if we do via
 *  the fallback table, conviction should be heavily discounted). */
function polarityClarityScore(
  sentiment: "positive" | "negative" | "neutral",
): number {
  return sentiment === "neutral" ? 0.30 : 0.95;
}

/** Novelty — penalize stories that already have many near-duplicates
 *  classified ahead of this one (likely already priced in). */
function noveltyScore(eventId: string): number {
  // Count how many duplicate news_events point at the same canonical.
  // The first occurrence is the canonical (no `duplicate_of` row points
  // at it); subsequent copies have `duplicate_of=this_event`.
  interface Row {
    n: number;
  }
  const r = db()
    .prepare<[string], Row>(
      `SELECT COUNT(*) AS n FROM news_events WHERE duplicate_of = ?`,
    )
    .get(eventId);
  const dups = r?.n ?? 0;
  // 0 dups = fully novel (score 1.0). Each additional copy reduces
  // novelty since the market has had more time to price it in.
  if (dups === 0) return 1.0;
  if (dups === 1) return 0.85;
  if (dups <= 3) return 0.70;
  if (dups <= 6) return 0.55;
  return 0.40;
}

function computeConvictionAxes(
  classificationConfidence: number,
  eventType: EventType,
  severity: "high" | "medium" | "low",
  sentiment: "positive" | "negative" | "neutral",
  sourceMeta: { is_blue_verified: number | null; author: string | null },
  eventId: string,
): ConvictionAxes {
  const axes = {
    classifier_confidence: classificationConfidence,
    tradability: resolveTradability(eventType, sentiment).score,
    severity: SEVERITY_MULTIPLIER[severity] ?? 0.5,
    source_tier: sourceTierScore(
      sourceMeta.is_blue_verified,
      sourceMeta.author,
    ),
    polarity_clarity: polarityClarityScore(sentiment),
    event_type_weight: EVENT_TYPE_WEIGHT[eventType] ?? 0.2,
    novelty: noveltyScore(eventId),
  };
  const total =
    axes.classifier_confidence * AXIS_WEIGHTS.classifier_confidence +
    axes.tradability * AXIS_WEIGHTS.tradability +
    axes.severity * AXIS_WEIGHTS.severity +
    axes.source_tier * AXIS_WEIGHTS.source_tier +
    axes.polarity_clarity * AXIS_WEIGHTS.polarity_clarity +
    axes.event_type_weight * AXIS_WEIGHTS.event_type_weight +
    axes.novelty * AXIS_WEIGHTS.novelty;
  return { ...axes, total: Math.max(0, Math.min(1, total)) };
}

/** Legacy shim: returns just the total. Kept so existing callers can
 *  migrate gradually. New callers should use computeConvictionAxes. */
function tradeConviction(
  classificationConfidence: number,
  eventType: EventType,
  severity: "high" | "medium" | "low",
  sentiment: "positive" | "negative" | "neutral",
): number {
  const { score: trad } = resolveTradability(eventType, sentiment);
  const sev = SEVERITY_MULTIPLIER[severity] ?? 0.5;
  return classificationConfidence * trad * sev;
}

/**
 * Safety-net heuristic: even if the classifier said live/today, scan the
 * title + first chunk of body for explicit OLD date strings. Returns true
 * if we should reject this as stale.
 *
 * Rejects on patterns like:
 *   • "April 9 2026" or "1/9 April 2026" when the article is from May+
 *   • "in 2024", "in Q1 2025", "since January"
 *   • Past-tense narrative cues: "Reflecting on", "Looking back", "Recap"
 */
function looksLikeStaleByDate(
  title: string,
  content: string | null,
  releaseTime: number,
): boolean {
  const text = (title + " " + (content ?? "")).slice(0, 800).toLowerCase();
  const releaseDate = new Date(releaseTime);
  const releaseYear = releaseDate.getUTCFullYear();
  const releaseMonth = releaseDate.getUTCMonth(); // 0-11

  // Past-month patterns (months before the release month).
  const monthNames = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  for (let m = 0; m < releaseMonth; m++) {
    if (text.includes(monthNames[m])) {
      // Saw an earlier month in the article. Could be a date reference.
      // Require the *year* nearby to be explicit — otherwise "in August"
      // might mean upcoming August.
      const re = new RegExp(`${monthNames[m]}.{0,30}${releaseYear}`, "i");
      if (re.test(text)) return true;
      // Or the prior year mentioned.
      const re2 = new RegExp(`${monthNames[m]}.{0,30}${releaseYear - 1}`, "i");
      if (re2.test(text)) return true;
    }
  }

  // Explicit prior-year mentions.
  if (text.includes(`${releaseYear - 1}`) || text.includes(`${releaseYear - 2}`)) {
    // "in 2024", "since 2023" — look-back signal
    if (
      /\b(in|during|since|throughout|back in|q[1-4]\s+\d{4}|reflecting|looking back|recap|aftermath)\b/i.test(
        text,
      )
    ) {
      return true;
    }
  }

  // Strong past-tense / retrospective cue words anywhere in title.
  const titleLower = title.toLowerCase();
  if (
    /\b(reflecting on|looking back|in retrospect|post[-\s]mortem|recap of|aftermath of|the (april|march|january|february|may|june|july|august|september|october|november|december)\s+\d|years ago|months? ago)\b/i.test(
      titleLower,
    )
  ) {
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Defense-in-depth: contradiction detector
//
// Even with v5 prompt fixes, Claude may occasionally produce a sentiment
// that contradicts its own reasoning text. Real example from before the
// fix: classifier output sentiment="negative" with affected_asset_ids=
// ["tok-arb","tok-op","tok-eth"] but the reasoning literally said
// "long dominant L2 tokens (ARB, OP)". Firing SHORT signals on assets
// the reasoning explicitly named as longs is the worst class of bug —
// the system actively traded against itself.
//
// This detector scans the reasoning text for explicit per-asset
// directional language and refuses to fire when it disagrees with the
// inferred direction. False positives would suppress real signals; we
// keep the patterns conservative and require the asset's symbol to be
// adjacent to the directional phrase.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Article-level polarity check. Returns true when the OVERALL reasoning
 * text declares the news bullish/bearish in a way that contradicts the
 * inferred trade direction. Unlike `reasoningContradictsDirection`,
 * this doesn't require the asset symbol to be adjacent — it catches
 * cases like "major bullish regulatory signal" where the polarity is
 * a global statement about the event itself.
 *
 * Real example this catches: classifier output sentiment=positive but
 * (pre-Fix-1) the signal generator forced direction=short on a
 * regulatory event. The reasoning said "major bullish signal" → this
 * function returns true → block the SHORT.
 */
function reasoningPolarityContradicts(
  reasoning: string,
  direction: "long" | "short",
): boolean {
  const t = reasoning.toLowerCase();
  // Strong, unambiguous polarity declarations.
  const bullish = [
    "bullish signal",
    "bullish catalyst",
    "bullish for",
    "bullish on",
    "is bullish",
    "major bullish",
    "strongly bullish",
    "positive catalyst",
    "positive for the",
    "tailwind for",
    "favorable for",
    "good news for",
    "boost to",
    "supportive of",
    "regulatory tailwind",
    "regulatory clarity is bullish",
  ];
  const bearish = [
    "bearish signal",
    "bearish catalyst",
    "bearish for",
    "bearish on",
    "is bearish",
    "major bearish",
    "strongly bearish",
    "negative catalyst",
    "negative for the",
    "headwind for",
    "unfavorable for",
    "bad news for",
    "drag on",
    "regulatory headwind",
  ];
  if (direction === "short") {
    for (const cue of bullish) {
      if (t.includes(cue)) return true;
    }
  } else {
    for (const cue of bearish) {
      if (t.includes(cue)) return true;
    }
  }
  return false;
}

/**
 * Returns true when the reasoning text contains explicit language that
 * contradicts the proposed direction for this asset.
 *
 * Example: direction="short", symbol="ARB", reasoning includes
 * "long dominant L2 tokens (ARB, OP)" → returns true → skip the signal.
 */
function reasoningContradictsDirection(
  reasoning: string,
  symbol: string,
  direction: "long" | "short",
): boolean {
  if (!symbol) return false;
  const text = reasoning.toLowerCase();
  const sym = symbol.toLowerCase();
  // Cap search distance to a 60-char window around the symbol to avoid
  // matching unrelated phrases elsewhere in the paragraph.
  // NOTE: We must use a STRING source (not template literal) because
  // `\b` inside a template literal is the backspace character (),
  // not the regex word-boundary metachar — the original `\b${sym}\b`
  // produced a regex that searched for literal backspace bytes and
  // never matched anything. The contradiction detector was silently
  // broken until this fix.
  const cleanSym = sym.replace(/[^a-z0-9]/g, "");
  const SYM_RE = new RegExp("\\b" + cleanSym + "\\b", "g");
  const matches = [...text.matchAll(SYM_RE)];
  if (matches.length === 0) return false;

  // Phrases that imply LONG bias (signal SHORT contradicts these)
  const longCues = [
    "long ",
    "longs ",
    "buy ",
    "buying ",
    "accumulate",
    "accumulating",
    "bullish for",
    "bullish on",
    "winner",
    "winners",
    "dominate",
    "dominant",
    "favored",
    "advantage",
    "outperform",
    "leadership",
    "beneficiar",
  ];
  // Phrases that imply SHORT bias (signal LONG contradicts these)
  const shortCues = [
    "short ",
    "shorts ",
    "sell ",
    "selling ",
    "dump ",
    "dumping",
    "bearish for",
    "bearish on",
    "loser",
    "losers",
    "underperform",
    "weakness",
    "decline",
    "drop in",
    "shutdown",
    "shut down",
    "shutting down",
    "collapse",
  ];

  const cues = direction === "short" ? longCues : shortCues;
  for (const m of matches) {
    const i = m.index ?? 0;
    const start = Math.max(0, i - 60);
    const end = Math.min(text.length, i + sym.length + 60);
    const window = text.slice(start, end);
    for (const cue of cues) {
      if (window.includes(cue)) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Tier resolution
// ─────────────────────────────────────────────────────────────────────────

function resolveTier(
  confidence: number,
  s: ReturnType<typeof Settings.getSettings>,
): "auto" | "review" | "info" | null {
  if (confidence >= s.auto_trade_min_confidence) return "auto";
  if (confidence >= s.review_min_confidence) return "review";
  if (confidence >= s.info_min_confidence) return "info";
  return null;
}

/**
 * Count corroborating sources for a story.
 *
 * "Corroboration" = how many independent outlets covered the same
 * underlying story. We use two complementary signals to count:
 *
 *   1. Near-duplicate articles linked via `news_events.duplicate_of`
 *      (the news-ingest dedup pipeline).
 *   2. Other classified events within ±24h with the SAME event_type
 *      AND ≥1 shared affected_asset_id. This catches different
 *      outlets that worded the same story too differently for the
 *      Jaccard dedup to match — but that the AI reliably classifies
 *      into the same bucket.
 *
 * We use the count to gate AUTO tier: if a story is reported by only
 * ONE source, AUTO fires user capital based on a single tweet. AUTO
 * requires ≥1 corroborating coverage (= 2 total sources). Stories
 * that pass AUTO threshold but lack corroboration are downgraded to
 * REVIEW so the human-in-the-loop can verify.
 */
function corroborationCount(
  eventId: string,
  releaseTime: number,
  eventType: string,
  affectedIds: string[],
): number {
  // Path 1: explicit duplicates linked by the news ingest dedup.
  const explicit = db()
    .prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM news_events WHERE duplicate_of = ?`,
    )
    .get(eventId);

  // Path 2: other classified events covering the same story within
  // ±24h. Match by event_type + ≥1 shared affected_asset_id.
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  if (affectedIds.length === 0) return explicit?.n ?? 0;

  // We need to do the asset-set overlap check in JS since SQLite can't
  // efficiently do "JSON array intersection". Pull candidate events
  // from the time window with the same event_type and check overlap.
  interface Cand {
    event_id: string;
    affected_asset_ids: string;
  }
  const cands = db()
    .prepare<[number, number, string, string], Cand>(
      `SELECT c.event_id, c.affected_asset_ids
       FROM classifications c
       JOIN news_events n ON n.id = c.event_id
       WHERE n.release_time BETWEEN ? AND ?
         AND c.event_type = ?
         AND c.event_id != ?`,
    )
    .all(
      releaseTime - WINDOW_MS,
      releaseTime + WINDOW_MS,
      eventType,
      eventId,
    );

  const newSet = new Set(affectedIds);
  let implicit = 0;
  for (const c of cands) {
    const ids = JSON.parse(c.affected_asset_ids) as string[];
    if (ids.some((a) => newSet.has(a))) implicit++;
  }

  return (explicit?.n ?? 0) + implicit;
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export interface SignalGenSummary {
  classifications_scanned: number;
  signals_created: number;
  signals_skipped_no_tradable: number;
  signals_skipped_no_direction: number;
  signals_skipped_below_threshold: number;
  signals_skipped_duplicate: number;
  signals_skipped_not_actionable: number;
  signals_skipped_stale_event: number;
  signals_skipped_stale_by_date: number;
  signals_skipped_no_classification_v2: number;
  /** Multi-asset narrative classifications suppressed wholesale. */
  signals_skipped_multi_asset_narrative: number;
  /** Per-asset skips because reasoning text contradicted the direction. */
  signals_skipped_reasoning_contradiction: number;
  by_tier: Record<"auto" | "review" | "info", number>;
  latency_ms: number;
}

interface ClassRow {
  event_id: string;
  event_type: EventType;
  sentiment: "positive" | "negative" | "neutral";
  severity: "high" | "medium" | "low";
  confidence: number;
  actionable: number | null;
  event_recency: "live" | "today" | "this_week" | "older" | null;
  affected_asset_ids: string;
  reasoning: string;
  // v6 (D3) — null on rows classified before the v6 prompt.
  mechanism_length?: 1 | 2 | 3 | 4 | null;
  counterfactual_strength?: "weak" | "moderate" | "strong" | null;
  // D1 — set when this article was a continuation of prior coverage.
  coverage_continuation_of?: string | null;
}

/**
 * Run the signal generator over recent classifications.
 * Looks back `lookbackHours` (default 72h) so we don't miss anything.
 */
export async function runSignalGen(
  opts: { lookbackHours?: number } = {},
): Promise<SignalGenSummary> {
  const t0 = Date.now();
  const lookbackMs = (opts.lookbackHours ?? 72) * 60 * 60 * 1000;
  const since = Date.now() - lookbackMs;

  const settings = Settings.getSettings();

  // Load empirical tradability scores from impact_metrics. Override
  // hardcoded values when we have ≥5 samples per event_type. Imported
  // here to avoid a circular dependency at module load.
  try {
    const { empiricalTradability } = await import("@/lib/analysis/patterns");
    _empiricalCache = empiricalTradability(5);
  } catch {
    _empiricalCache = null;
  }

  // Lifecycle sweeper: dismiss any pending signals that have aged past
  // their subtype-derived expires_at OR a corroboration_deadline with
  // still-zero corroborating sources. AUTHORITATIVE: pipeline/lifecycle.ts
  // + repos/signals.sweepExpiredSignals. Idempotent — runs every gen cycle.
  try {
    const swept = Signals.sweepExpiredSignals();
    if (swept.stale_unexecuted + swept.uncorroborated > 0) {
      console.log(
        `[signal-gen] lifecycle sweep: stale=${swept.stale_unexecuted} uncorroborated=${swept.uncorroborated}`,
      );
    }
  } catch (e) {
    // Sweeper failure is non-fatal — generator continues.
    console.warn("[signal-gen] lifecycle sweep failed:", e);
  }

  interface RowWithTitle extends ClassRow {
    release_time: number;
    title: string;
    content: string | null;
    is_blue_verified: number | null;
    author: string | null;
  }
  // Pull recent classifications joined with event metadata.
  // Includes author + is_blue_verified for the source-tier axis.
  const rows = db()
    .prepare<[number], RowWithTitle>(
      `SELECT c.event_id, c.event_type, c.sentiment, c.severity, c.confidence,
              c.actionable, c.event_recency,
              c.affected_asset_ids, c.reasoning,
              c.mechanism_length, c.counterfactual_strength,
              c.coverage_continuation_of,
              n.release_time, n.title, n.content,
              n.is_blue_verified, n.author
       FROM classifications c
       JOIN news_events n ON n.id = c.event_id
       WHERE n.release_time >= ?
       ORDER BY n.release_time DESC`,
    )
    .all(since);

  // Window for dedup of similar signals (same asset/direction/event_type).
  // Set to 12h: a single news cycle (Coinbase Q1 miss, SEC announcement,
  // exploit) gets covered by ~5-10 outlets within the first 6-8 hours.
  // 4h was letting late coverage trigger fresh signals on the same story.
  const DEDUP_WINDOW_MS = 12 * 60 * 60 * 1000;

  let created = 0;
  let skipNoTradable = 0;
  let skipNoDir = 0;
  let skipBelow = 0;
  let skipDup = 0;
  let skipNotActionable = 0;
  let skipStaleEvent = 0;
  let skipNoV2 = 0;
  let skipStaleByDate = 0;
  let skipMultiAssetNarrative = 0;
  let skipReasoningContradiction = 0;
  const byTier = { auto: 0, review: 0, info: 0 };

  for (const r of rows) {
    const affectedIds = JSON.parse(r.affected_asset_ids) as string[];

    // Gate 1: skip classifications from before v2 prompt — they don't have
    // actionable/recency info, so we can't tell if they're stale.
    if (r.actionable === null || r.event_recency === null) {
      skipNoV2 += affectedIds.length;
      continue;
    }

    // Gate 2: skip if not actionable.
    if (r.actionable !== 1) {
      skipNotActionable += affectedIds.length;
      continue;
    }

    // Gate 3: skip if event is older than today. Trading on week-old or
    // archived news is pointless — the move already happened.
    if (r.event_recency !== "live" && r.event_recency !== "today") {
      skipStaleEvent += affectedIds.length;
      continue;
    }

    // Gate 3a: HARD news-age filter. event_recency is set ONCE at
    // classification time and never updated. If we classified an event
    // as "live" on May 7 and it's now May 9, the classification still
    // says "live" — but the news is two days old and the move's
    // already happened. Reject anything older than 36h regardless of
    // what the recency field claims. This is what stopped May 7 events
    // from showing up as fresh signals on May 9.
    const ageMs = Date.now() - r.release_time;
    const MAX_NEWS_AGE_MS = 36 * 60 * 60 * 1000;
    if (ageMs > MAX_NEWS_AGE_MS) {
      skipStaleEvent += affectedIds.length;
      continue;
    }

    // Gate 3b: SAFETY NET — even if Claude said live/today, scan title +
    // first 500 chars of body for explicit OLD date strings (e.g. "April",
    // "2024", "Q1 2025") and skip if found. Catches misclassifications.
    if (looksLikeStaleByDate(r.title, r.content, r.release_time)) {
      skipStaleByDate += affectedIds.length;
      continue;
    }

    // Gate 3d: DIGEST/ROUNDUP ARTICLES.
    // Articles bundling multiple unrelated events ("Crypto One Liners",
    // "Daily Wrap", etc.) get scored as one mushy aggregate signal. The
    // classifier can't reliably attribute the catalyst to a single asset
    // because there are 5 different events in the body. Drop them.
    //
    // AUTHORITATIVE: src/lib/pipeline/digest.ts (`detectDigest`).
    // Tested in tests/digest.test.ts + tests/adversarial-fixtures.test.ts (F09).
    // Falls back to the inline `isDigestArticle` if the module ever returns
    // false but the legacy heuristic would have caught it (defense in depth).
    const digest = detectDigest({ title: r.title, content: r.content });
    if (digest.is_digest || isDigestArticle(r.title)) {
      skipStaleByDate += affectedIds.length;
      continue;
    }

    // Gate 3c: SUPPRESS MULTI-ASSET NARRATIVE.
    // Articles classified as event_type="narrative" with multiple
    // affected assets are the highest-risk class for the "winners and
    // losers in the same article" bug — even after the v5 prompt fix,
    // research/commentary pieces frequently span both directions. They
    // also have the lowest historical tradability (0.25). Wholesale
    // suppression here is the cheap, high-precision defense.
    if (r.event_type === "narrative" && affectedIds.length > 1) {
      skipMultiAssetNarrative += affectedIds.length;
      continue;
    }

    const direction = inferDirection({
      event_id: r.event_id,
      event_type: r.event_type,
      sentiment: r.sentiment,
      severity: r.severity,
      confidence: r.confidence,
      actionable: true,
      event_recency: r.event_recency,
      affected_asset_ids: affectedIds,
      reasoning: r.reasoning,
      model: "",
      prompt_version: "",
      classified_at: 0,
    });
    if (!direction) {
      skipNoDir += affectedIds.length;
      continue;
    }

    // Compute conviction across multiple weighted axes. Each axis is
    // tracked individually so the signal's reasoning can show the user
    // exactly why it scored high or low.
    const axes = computeConvictionAxes(
      r.confidence,
      r.event_type,
      r.severity,
      r.sentiment,
      { is_blue_verified: r.is_blue_verified, author: r.author },
      r.event_id,
    );
    const conviction = axes.total;
    let tier = resolveTier(conviction, settings);
    // Source-corroboration gate for AUTO: require ≥1 duplicate article
    // pointing at this canonical event (= 2+ outlets reported the
    // story). A single tweet at AUTO conviction is too risky to
    // auto-execute on. Downgrade to REVIEW (= manual approval).
    // Compute corroboration once for both AUTO downgrade + age-staleness check.
    const corroboration = corroborationCount(
      r.event_id,
      r.release_time,
      r.event_type,
      affectedIds,
    );

    // ── Age-staleness gate ──
    // News >12h old AND no corroboration = unverified rumor that's
    // already dead alpha. Real example: "Switzerland's largest bank
    // dropped $1.12B bet on Strategy" sat in the feed for 21h on a
    // single tweet. UBS exiting a $1B+ position would be Bloomberg-
    // covered within hours; if no corroboration appears in 12h, the
    // story isn't going to materialize and the signal shouldn't be
    // burning slot space in the active queue.
    const ageHours = (Date.now() - r.release_time) / (60 * 60 * 1000);
    if (ageHours > 12 && corroboration === 0) {
      skipStaleEvent += affectedIds.length;
      continue;
    }

    let corroborationDowngraded = false;
    if (tier === "auto" && corroboration < 1) {
      tier = "review";
      corroborationDowngraded = true;
    }
    if (!tier) {
      skipBelow += affectedIds.length;
      continue;
    }

    // ── Fix A — Smart asset routing ────────────────────────────
    // Some event_types are tightly bound to a specific kind of asset.
    // E.g. "earnings" or "treasury" news is about the COMPANY, not
    // crypto markets broadly — skip token/index proxies for those.
    // For other types let Claude's affected_asset_ids stand.
    const allowedKindsByEventType: Partial<Record<EventType, Array<string>>> = {
      earnings: ["stock", "treasury"],
      // (no others restricted today — add as we observe miscategorisations)
    };
    const allowedKinds = allowedKindsByEventType[r.event_type];
    const filteredIds = allowedKinds
      ? affectedIds.filter((id) => {
          const a = Assets.getAssetById(id);
          return a && allowedKinds.includes(a.kind);
        })
      : affectedIds;
    // If smart routing eliminated everything, fall back so we don't drop
    // the signal entirely.
    const baseIds = filteredIds.length > 0 ? filteredIds : affectedIds;

    // ── Asset-selection precision ──
    // AUTHORITATIVE: src/lib/pipeline/asset-router.ts (`routeAssets`).
    // Tested in tests/asset-router.test.ts + adversarial-fixtures (F01-F03).
    //
    // Replaces the prior KIND_PRIORITY sort (which was a coarse
    // basket-vs-specific tiebreaker) with explicit per-candidate
    // relevance scoring:
    //   subject              1.0  (named in headline opening)
    //   directly_affected    0.8  (named anywhere in title)
    //   basket_with_member   0.5  (basket containing a verified subject)
    //   incidentally_mentioned 0.3 (only in affected_asset_ids)
    //   basket_without_member 0.0 (BLOCK — basket without subject member)
    //
    // The router rejects any basket whose constituents don't intersect
    // the named affected entities (Bug 1: MAG7 fired on COIN/MSTR news).
    // It also has a listing-event override (Bug 1: BTC fired on PROS
    // listing because BTC appeared as quote currency in the trading pair).
    const candidatesForRouter = baseIds
      .map((id) => {
        const a = Assets.getAssetById(id);
        if (!a) return null;
        return {
          asset_id: a.id,
          symbol: a.symbol,
          kind: a.kind,
          tradable: !!a.tradable,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    const routing = routeAssets({
      title: r.title,
      candidates: candidatesForRouter,
      affected_asset_ids: affectedIds,
      event_type: r.event_type,
    });

    // If the router rejected every candidate (e.g. only basket_without_member
    // candidates) → no credible primary → drop the event.
    if (!routing.primary) {
      skipNoTradable += affectedIds.length;
      continue;
    }

    // Build idsToUse by putting the router's primary first, then any other
    // baseIds (preserving their original order) so the existing per-asset
    // gate loop below stays as defense-in-depth. The router's verdict is
    // authoritative for which asset becomes primary; the loop's existing
    // checks still run on it.
    const idsToUse = [
      routing.primary.asset_id,
      ...baseIds.filter((id) => id !== routing.primary!.asset_id),
    ];

    // ── Article-level polarity check (event-wide, not per-asset) ──
    // If the reasoning declares the news "bullish" / "bearish" overall
    // and the proposed direction disagrees, refuse the entire event.
    // Catches the kind of bug the buildathon critic flagged: classifier
    // says "major bullish regulatory signal" but direction is short.
    if (reasoningPolarityContradicts(r.reasoning, direction)) {
      skipReasoningContradiction += idsToUse.length;
      continue;
    }

    // ── Story-level dedup ──
    // Detect when the same UNDERLYING story has already produced a
    // pending signal under a different primary asset. Real example:
    // 3 separate news_events about the IREN×NVIDIA partnership fired
    // signals on (idx-ssimag7), (tok-btc), (stk-nvda) — same story,
    // 3 dashboard rows.
    //
    // Search for pending signals in the last 12h with the same
    // event_type + direction whose covered asset set (primary +
    // secondaries) has ≥50% Jaccard overlap with this event's
    // affected_asset_ids. If such a signal exists and is stronger →
    // drop this event. If we're stronger → defer the supersede call
    // until we have a new signal id (see below at insertSignal).
    const STORY_WINDOW_MS = 12 * 60 * 60 * 1000;
    const storyMatches = Signals.findStoryOverlap({
      asset_ids: affectedIds,
      event_type: r.event_type,
      direction,
      window_ms: STORY_WINDOW_MS,
    });
    const storyConflict = storyMatches[0]; // strongest existing
    if (storyConflict && storyConflict.confidence >= conviction) {
      skipDup += idsToUse.length;
      continue;
    }
    // (We'll mark `storyConflict` as superseded after creating our new
    // signal id, so the audit trail points to the actual replacement.)

    // ── ONE EVENT → ONE SIGNAL ──
    // Walk idsToUse and find the FIRST tradable asset that passes all
    // per-asset gates. Fire ONE signal on it. The rest get recorded as
    // secondary_asset_ids for UI display ("also affected: BTC, MAG7").
    //
    // This stops the duplicate-signal spam (Arbitrum DAO event firing
    // 3 separate signals on ARB, AAVE, ssidefi). The event was always
    // ONE story; surfacing it as 3 signals inflated the active list
    // and made the dashboard look noisier than the news flow actually
    // was.
    let primaryAsset: ReturnType<typeof Assets.getAssetById> = undefined;
    let primaryAssetId: string | null = null;
    let opposite: ReturnType<
      typeof Signals.findOppositePendingForAsset
    > = undefined;
    const candidateAssets: string[] = [];

    for (const assetId of idsToUse) {
      const asset = Assets.getAssetById(assetId);
      if (!asset?.tradable) {
        skipNoTradable++;
        continue;
      }
      // ── Venue-direction gate ──
      // You can't short on spot — only perp supports going short. If the
      // signal direction is "short" and the asset's only tradable hint is
      // a spot pair, skip it. Counted under no-tradable since from the
      // perspective of "can we actually fill this signal" the answer is no.
      if (direction === "short" && asset.tradable.market === "spot") {
        skipNoTradable++;
        continue;
      }
      if (Signals.existsForEventAsset(r.event_id, assetId)) {
        skipDup++;
        continue;
      }
      if (
        reasoningContradictsDirection(r.reasoning, asset.symbol, direction)
      ) {
        skipReasoningContradiction++;
        continue;
      }

      // Proxy-hallucination gate for listing events. Catches the
      // "Upbit lists PROS → fires BTC LONG" bug where the classifier
      // (especially v3) used a major asset as a stand-in for an
      // unlisted small-cap. Specific to listings — uses listed-token
      // extraction.
      if (isProxyHallucinatedListing(r.event_type, asset.symbol, r.title)) {
        skipReasoningContradiction++;
        continue;
      }

      // General proxy-hallucination gate. Catches the broader pattern:
      // any subject-specific event_type (security, exploit, partnership,
      // etc.) firing on a major asset (BTC/ETH/SOL/etc.) when the
      // article doesn't substantively name that major. Real example:
      // a LayerZero security disclosure firing BTC SHORT because the
      // classifier used BTC as a "Layer-1 proxy for ZRO".
      if (
        isProxyHallucinatedGeneral(
          r.event_type,
          asset.symbol,
          r.title,
          r.content,
        )
      ) {
        skipReasoningContradiction++;
        continue;
      }
      if (
        Signals.existsRecentForAssetDirection(
          assetId,
          direction,
          r.event_type,
          DEDUP_WINDOW_MS,
        )
      ) {
        skipDup++;
        continue;
      }

      // ── Per-asset same-direction cap ──
      // Enforce "at most one pending signal per (asset, direction)".
      // Same-direction signals from different events on the same asset
      // are duplicates — keep highest conviction.
      //
      // OPPOSITE-direction signals are NOT capped here. Two catalysts
      // disagreeing on an asset (MSTR LONG from JPMorgan vs MSTR SHORT
      // from UBS) are both legitimate and tradeable. Those go through
      // `findOppositePendingForAsset` below for conflict resolution.
      const sameDirPending = Signals.findSameDirectionPendingForAsset(
        assetId,
        direction,
      );
      const stronger = sameDirPending.find((s) => s.confidence >= conviction);
      if (stronger) {
        skipDup++;
        continue;
      }

      // We're stronger than any same-direction pending. The strongest
      // existing same-direction is what we'll supersede after firing.
      const toSupersede = sameDirPending[0];

      // This asset qualifies. The FIRST one becomes primary; subsequent
      // ones become secondaries.
      if (primaryAssetId === null) {
        primaryAssetId = assetId;
        primaryAsset = asset;
        opposite = toSupersede;
      } else {
        candidateAssets.push(assetId);
      }
    }

    if (primaryAssetId === null || !primaryAsset?.tradable) {
      // No qualifying asset for this event — nothing to fire.
      continue;
    }

    // Severity → size scaling.
    const sizeMult = SEVERITY_MULTIPLIER[r.severity] ?? 0.5;
    const size = Math.round(settings.default_position_size_usd * sizeMult);

    // Show the per-axis breakdown so the user can audit how conviction
    // was reached — every score is attributable.
    const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
    const breakdown =
      `Conviction ${pct(conviction)} = ` +
      `cls ${pct(axes.classifier_confidence)} × ${(AXIS_WEIGHTS.classifier_confidence * 100).toFixed(0)}w + ` +
      `tradability ${pct(axes.tradability)} × ${(AXIS_WEIGHTS.tradability * 100).toFixed(0)}w + ` +
      `severity ${pct(axes.severity)} × ${(AXIS_WEIGHTS.severity * 100).toFixed(0)}w + ` +
      `source ${pct(axes.source_tier)} × ${(AXIS_WEIGHTS.source_tier * 100).toFixed(0)}w + ` +
      `clarity ${pct(axes.polarity_clarity)} × ${(AXIS_WEIGHTS.polarity_clarity * 100).toFixed(0)}w + ` +
      `category ${pct(axes.event_type_weight)} × ${(AXIS_WEIGHTS.event_type_weight * 100).toFixed(0)}w + ` +
      `novelty ${pct(axes.novelty)} × ${(AXIS_WEIGHTS.novelty * 100).toFixed(0)}w.`;
    let enrichedReasoning = `${r.reasoning}\n\n${breakdown}`;
    if (corroborationDowngraded) {
      enrichedReasoning +=
        `\n\nDowngraded from AUTO to REVIEW: only 1 source on file. ` +
        `AUTO tier requires ≥2 independent outlets covering the story.`;
    }
    if (candidateAssets.length > 0) {
      const symbols = candidateAssets
        .map((id) => Assets.getAssetById(id)?.symbol ?? id)
        .join(", ");
      enrichedReasoning += `\n\nAlso affected: ${symbols}.`;
    }

    const newSignalId = randomUUID();

    // NOTE: the markSuperseded calls that USED to live here were moved
    // inside the insert transaction below. Running them ahead of the
    // pre-save invariant gate created phantom supersessions: when the
    // gate refused the new signal, the markSuperseded had already
    // committed → the old signal was marked superseded by a brand-new
    // UUID that was never inserted. Real bug caught when "Generate
    // Signals Now" left active SOL signals in zombie status referring
    // to non-existent superseders. Order is now:
    //   1. compute new signal data
    //   2. invariant gate (continue on refusal — NO state mutation yet)
    //   3. transaction: insertSignal + markSuperseded(old → new) + outcome
    // If anything in step 3 throws, the whole thing rolls back.

    // ── Pipeline metadata (catalyst subtype, lifecycle, chain id) ──
    // AUTHORITATIVE: src/lib/pipeline/{catalyst-subtype,lifecycle,entity-history}.ts
    // The risk profile is now subtype-aware AND vol-normalized — same nominal
    // % on BTC vs AMZN no longer come from the same constant. Lifecycle
    // expires_at is derived from the subtype's decay profile. event_chain_id
    // binds signals on the same evolving story across days.
    const subtype = inferCatalystSubtype(r.event_type, {
      title: r.title,
      sentiment: r.sentiment,
    });
    const vol = realizedVol30d(primaryAssetId);

    // ── Risk derivation: base rate table → vol-aware fallback ──
    // AUTHORITATIVE: src/lib/pipeline/base-rates.ts (Dimension 5).
    // We first consult base_rates.json for the (subtype, asset_class) pair.
    // If an entry exists, the target/stop/horizon come from the calibrated
    // band — replacing the LLM-intuited values that used to give the same
    // +18% target on BTC and AMZN. If no entry exists, we fall back to
    // riskProfileForSubtype (vol-normalized) and log per I-29.
    const assetClass = classifyAssetClass({
      kind: primaryAsset.kind,
      symbol: primaryAsset.symbol,
    });
    const baseRate = assetClass ? getBaseRate(subtype, assetClass) : null;

    // ── Significance gate (Phase C, invariant I-41) ──
    // AUTHORITATIVE: src/lib/calibration/significance.ts.
    // Score EVERY signal that reaches this point, regardless of whether
    // the corpus or legacy base-rate table covers (subtype, asset_class).
    // scoreSignificance internally falls back through:
    //   1. corpus-derived rate (data/base-rates.json)
    //   2. legacy hand-curated rate (pipeline/base_rates.json)
    //   3. magnitude=0 — instance strength + novelty still produce a score
    // The drop gate at 0.25 fires uniformly. ALL persisted signals MUST
    // carry a non-null significance_score (invariant I-45).
    const assetRelevanceScore = relevanceScoreFromLevel(routing.primary.relevance);
    const recentHeadlines = recentHeadlinesForAsset(primaryAssetId);
    const sig = scoreSignificance({
      headline: r.title,
      subtype,
      // When the runtime asset_class mapper returns null (rare — kind=macro
      // or unmapped equities), pass a sentinel string. scoreSignificance
      // treats unknown classes as "no base-rate cell" and proceeds with
      // magnitude=0; the gate then decides on instance/novelty alone.
      asset_class: assetClass ?? "unknown",
      asset_relevance: assetRelevanceScore,
      recent_headlines: recentHeadlines,
    });
    if (sig.tier === "drop") {
      insertDroppedHeadline({
        id: `${r.event_id}:${primaryAssetId}`,
        headline_text: r.title,
        classified_subtype: subtype,
        classified_asset: primaryAsset.symbol,
        significance_score: sig.score,
        significance_components: sig.components,
        significance_reasoning: sig.reasoning,
      });
      skipBelow++;
      continue;
    }
    // Significance overrides the upstream tier mapping. Downstream caps
    // (promotional, reliability, price-realized, base-rate) can still
    // downgrade further but cannot promote above significance.tier.
    tier = sig.tier;
    const significanceScore: number = sig.score;
    enrichedReasoning += `\n\nSignificance ${sig.score.toFixed(3)} → ${sig.tier.toUpperCase()}. ${sig.reasoning}`;

    // ── Direction-lock validator (Phase G, invariant I-47) ──
    // AUTHORITATIVE: src/lib/calibration/direction-lock.ts.
    // 22 of 28 corpus (subtype × asset_class) buckets are direction-
    // locked — every historical observation moved one way. When the
    // proposed direction contradicts the lock, soft-flag rather than
    // hard-reject (corpus is finite; a real reversal might emerge).
    // Cap tier at REVIEW so it can't reach AUTO without human review.
    if (assetClass) {
      const lockCheck = checkDirectionLock({
        subtype,
        asset_class: assetClass,
        direction,
      });
      if (lockCheck.violation) {
        enrichedReasoning +=
          `\n\nDirection-lock flag: ${lockCheck.reasoning}.` +
          ` Conviction soft-capped at ${DIRECTION_LOCK_CONVICTION_CAP}` +
          ` pending human review; tier held at REVIEW.`;
        if (tier === "auto") tier = "review";
      }
    }

    let stopPct: number;
    let targetPct: number;
    let horizon: string;
    let baseRateUsed = false;
    if (baseRate) {
      const r = riskFromBaseRate(baseRate);
      stopPct = r.stop_pct;
      targetPct = r.target_pct;
      horizon = horizonHoursToString(r.horizon_hours);
      baseRateUsed = true;
    } else {
      // Falling through to subtype defaults — log so we can observe
      // which (subtype, class) combinations need calibration.
      const riskV2 = riskProfileForSubtype(subtype, vol);
      stopPct = riskV2.stop_pct;
      targetPct = riskV2.target_pct;
      horizon = riskV2.horizon;
      console.log(
        `[signal-gen] base-rate fallback: subtype=${subtype} class=${assetClass ?? "null"} (no calibration entry; using riskProfileForSubtype)`,
      );
    }

    const sourceTier = classifySourceTier({
      is_blue_verified: r.is_blue_verified,
      author: r.author,
    });
    const promo = scorePromotional(r.title, r.content);

    // Promotional cap: hyperbolic CT shill on a non-tier-1 source caps at INFO
    // regardless of conviction. AUTHORITATIVE: pipeline/promotional.ts.
    tier = capTierForPromotional(tier, promo, sourceTier);

    // Funding-magnitude cap: $12M seed on a $5B-cap chain → INFO.
    // We don't have market_cap_usd in the row; the cap is a no-op when
    // market_cap is null, which is the safe default. Wire fully when the
    // assets table starts carrying market caps. (For now: structural call.)
    if (subtype === "fundraising_announcement") {
      tier = capForFundingMagnitude(tier, {
        round_size_usd: 0, // not parsed from title yet; gate is a no-op
        market_cap_usd: null,
      });
    }

    const lifecycle = computeLifecycle({
      subtype,
      generated_at: Date.now(),
      source_tier: sourceTier,
    });

    const eventChainId = deriveEventChainId({
      primary_asset_id: primaryAssetId,
      affected_asset_ids: affectedIds,
      event_type: r.event_type,
      release_time: r.release_time,
    });

    // Entity-history adjustment: if a recent contradictory signal exists on
    // this asset, reduce conviction. AUTHORITATIVE: pipeline/entity-history.ts.
    const historyAdjust = adjustConvictionForHistory({
      new_direction: direction,
      new_conviction: conviction,
      primary_asset_id: primaryAssetId,
      new_event_chain_id: eventChainId,
      history: recentHistoryForAsset(primaryAssetId),
    });
    const finalConviction = historyAdjust.adjusted_conviction;
    if (historyAdjust.adjusted_conviction < conviction) {
      enrichedReasoning += `\n\nHistory adjustment: ${historyAdjust.reason}`;
    }

    // Re-resolve tier with adjusted conviction (only downgrade — entity
    // history can't promote a signal). Then re-apply promotional + funding
    // caps so a downgrade doesn't accidentally lift them.
    const reResolvedTier = resolveTier(finalConviction, settings);
    if (reResolvedTier == null) {
      // Adjusted conviction fell below INFO threshold — drop entirely.
      skipBelow++;
      continue;
    }
    tier = capTierForPromotional(reResolvedTier, promo, sourceTier);

    // ── Reliability caps (bug classes C + D) ──
    // AUTHORITATIVE: src/lib/pipeline/reliability.ts (`capTierForReliability`).
    // Tested in tests/reliability.test.ts.
    //
    // Two heuristics that downgrade signals when the SOURCE looks
    // unreliable, regardless of how confident the conviction math is:
    //
    //   C. Hedging language in classifier reasoning ("title says X body
    //      says Y", "likely commentary", "if confirmed", "rumored",
    //      "unverified", etc.) — the AI itself is signalling uncertainty,
    //      we used to ignore that.
    //   D. Anonymized-actor titles with specific dollar amounts
    //      ("Switzerland's largest bank dropped $1.12B bet…") — real
    //      news names the actor; tweet-aggregator copy often doesn't.
    //
    // Both bypass for tier-1 sources (Bloomberg/Reuters/SEC may use
    // hedged language responsibly).
    const hedgeScore = scoreReasoningHedge(r.reasoning);
    const anonScore = scoreAnonymizedActor(r.title);
    const relCap = capTierForReliability(tier, hedgeScore, anonScore, sourceTier);
    if (relCap.capped) {
      enrichedReasoning +=
        `\n\nReliability cap → INFO: ${relCap.reason}.` +
        ` Conviction ${(finalConviction * 100).toFixed(0)}% retained for audit;` +
        ` tier downgraded because the source signals its own uncertainty.`;
    }
    tier = relCap.tier;

    // ── Price-already-moved check (Dimension 2) ──
    // Compute realized_fraction from the asset's price at catalyst publish
    // time vs now. If the move is already mostly realized, downgrade or
    // drop. Prices come from klines_daily (we have 30+d for most assets);
    // when missing, the check returns null and we proceed unaffected.
    const expectedMovePct = baseRate?.mean_move_pct ?? targetPct;
    const catalystPrice = priceAtOrBefore(primaryAssetId, r.release_time);
    const currentPrice = mostRecentClose(primaryAssetId);
    const realizedFraction = computeRealizedFraction({
      direction,
      catalyst_price: catalystPrice,
      current_price: currentPrice,
      expected_move_pct: expectedMovePct,
    });
    if (realizedFraction != null) {
      const verdict = applyRealizedMoveCap({
        realized_fraction: realizedFraction,
        tier,
      });
      if (verdict.verdict === "drop") {
        skipBelow++;
        enrichedReasoning +=
          `\n\nPrice-already-moved drop: ${verdict.reason} (realized_fraction=${realizedFraction.toFixed(2)}).`;
        continue;
      }
      if (verdict.verdict === "downgrade" && verdict.tier !== tier) {
        enrichedReasoning +=
          `\n\nPrice-already-moved cap → ${verdict.tier.toUpperCase()}: ${verdict.reason} (realized_fraction=${realizedFraction.toFixed(2)}).`;
        tier = verdict.tier;
      }
    }

    // ── Base-rate conviction cap (Dimension 5) ──
    // When the calibrated base rate's mean move is < 2% on the predicted
    // side, the trade has limited upside even at high conviction. Cap
    // the conviction-derived tier accordingly. We DON'T re-resolveTier
    // here because the cap operates on the conviction value, not the
    // tier mapping; we just clamp it for audit and (in stricter modes)
    // for tier downgrade.
    if (baseRate) {
      const brCap = shouldCapConvictionFromBaseRate(baseRate);
      if (brCap.cap && finalConviction > brCap.ceiling) {
        // Downgrade tier if the ceiling crosses a threshold boundary.
        const downgraded = resolveTier(brCap.ceiling, settings);
        if (downgraded && downgraded !== tier) {
          enrichedReasoning +=
            `\n\nBase-rate cap → ${downgraded.toUpperCase()}: ${brCap.reason}.` +
            ` Calibrated mean move for ${subtype} × ${assetClass} is ${baseRate.mean_move_pct}% — limited upside, conviction capped.`;
          tier = downgraded;
        }
      }
    }

    // ── Pre-save invariant gate ──
    // LAST line of defense. AUTHORITATIVE: pipeline/invariants.ts.
    // Tested in tests/invariants.test.ts + adversarial-fixtures.
    // Any block-severity violation refuses the insert and logs which
    // upstream stage SHOULD have caught the issue.
    //
    // Asset relevance: if the inline per-asset gates picked a different
    // asset than the router's primary (because the router's pick failed
    // an existsForEventAsset / reasoningContradicts / proxy gate), we
    // RE-SCORE the chosen asset against the title via scoreAssetRelevance.
    // The previous code set a 0.5 placeholder here, which then HAPPENED
    // to clear the invariant gate's `relevance >= 0.5` floor — i.e. the
    // gate was being bypassed by a hardcoded number rather than enforced
    // by real evidence. Bug class E (regression: tests/asset-router.test.ts).
    const computedRelevance =
      routing.primary.asset_id === primaryAssetId
        ? relevanceScoreFromLevel(routing.primary.relevance)
        : (() => {
            const reScore = scoreAssetRelevance({
              candidate: {
                asset_id: primaryAssetId,
                symbol: primaryAsset.symbol,
                kind: primaryAsset.kind,
                tradable: !!primaryAsset.tradable,
              },
              title: r.title,
              affected_asset_ids: affectedIds,
              event_type: r.event_type,
            });
            return reScore.score;
          })();

    const preSave: PreSaveSignal = {
      asset_id: primaryAssetId,
      asset_kind: primaryAsset.kind,
      asset_symbol: primaryAsset.symbol,
      direction,
      tier,
      confidence: finalConviction,
      reasoning: enrichedReasoning,
      expected_horizon: horizon,
      suggested_stop_pct: stopPct,
      suggested_target_pct: targetPct,
      asset_relevance: computedRelevance,
      catalyst_subtype: subtype,
      promotional_score: promo.score,
      source_tier: sourceTier,
      expires_at: lifecycle.expires_at,
      corroboration_deadline: lifecycle.corroboration_deadline,
      event_chain_id: eventChainId,
      is_digest: false, // we already gated digest at Gate 3d
      title_validation_ok: true, // validateTitle runs at ingestion, not here
      // Dimension 5: base rate object for the (subtype, class) lookup.
      // null when no calibration entry exists; gate skips the rule.
      base_rate: baseRate,
      // Dimension 2: realized_fraction so the gate can verify the
      // upstream tier downgrade actually happened. null = price feed
      // unavailable, gate skips the rule.
      realized_fraction: realizedFraction,
      // Dimension 3/4: mechanism + counterfactual conviction caps.
      // Read from the classification row — null on legacy rows that
      // pre-date the reasoning-enriched classifier prompt.
      mechanism_length:
        (r as RowWithTitle & {
          mechanism_length?: 1 | 2 | 3 | 4 | null;
        }).mechanism_length ?? null,
      counterfactual_strength:
        (r as RowWithTitle & {
          counterfactual_strength?: "weak" | "moderate" | "strong" | null;
        }).counterfactual_strength ?? null,
    };
    void baseRateUsed; // logged via console; downstream auditor reads it
    const gateResult = checkSignalInvariants(preSave);
    if (!gateResult.ok) {
      // Log + skip. The blocking violation tells us which upstream stage
      // is leaky — fix there, not here.
      const blockedRules = gateResult.violations
        .filter((v) => v.severity === "block")
        .map((v) => `${v.rule}: ${v.message}`)
        .join("; ");
      console.warn(
        `[signal-gen] invariant gate BLOCK on event=${r.event_id} asset=${primaryAssetId} → ${blockedRules}`,
      );
      // Part 1 hook: record the gate refusal in signal_outcomes so the
      // calibration dashboard can surface what the gate caught.
      try {
        const firstRule =
          gateResult.violations.find((v) => v.severity === "block")?.rule ??
          "unknown_rule";
        Outcomes.insertBlockedOutcome({
          signal_id: newSignalId,
          asset_id: primaryAssetId,
          asset_class: assetClass ?? "unknown",
          direction,
          tier,
          conviction: finalConviction,
          catalyst_subtype: subtype,
          generated_at: Date.now(),
          horizon_hours:
            riskV2_horizon_hours_from_string(horizon) ?? 24,
          expires_at: lifecycle.expires_at,
          price_at_generation: catalystPrice,
          target_pct: targetPct,
          stop_pct: stopPct,
          rule: firstRule,
        });
      } catch (err) {
        console.warn(
          `[signal-gen] failed to record blocked outcome for ${newSignalId}: ${(err as Error).message}`,
        );
      }
      continue;
    }

    // ── Phase D/E — strict conflict + supersession at emission ──
    // AUTHORITATIVE: src/lib/calibration/conflicts.ts.
    // Look up any pending opposite-direction signal on this asset and
    // resolve per I-42/I-43. Three possible outcomes:
    //   • no_conflict           — proceed to insert.
    //   • suppress_new          — existing wins; new never persists,
    //                              logged to suppressed_signals.
    //   • suppress_existing     — new wins by < 1.5×; existing marked
    //                              'suppressed', logged to suppressed_signals.
    //   • supersede_existing    — new wins by ≥ 1.5×; existing marked
    //                              'superseded', logged to signal_supersessions.
    // Conflict resolution requires an asset_class to compare windows
    // sensibly; when missing, skip Phase D/E (the signal still inserts
    // with its non-null significance score).
    if (assetClass) {
      const oppositePending = Signals.findOppositePendingForAsset(
        primaryAssetId,
        direction,
      );
      if (oppositePending) {
        const newCand: ConflictCandidate = {
          id: newSignalId,
          direction,
          asset_id: primaryAssetId,
          start_at: Date.now(),
          expires_at: lifecycle.expires_at,
          asset_relevance: assetRelevanceScore,
          significance_score: significanceScore,
          conviction: finalConviction,
        };
        const existingCand: ConflictCandidate = {
          id: oppositePending.id,
          direction: oppositePending.direction,
          asset_id: oppositePending.asset_id,
          start_at: oppositePending.fired_at,
          expires_at:
            oppositePending.expires_at ??
            oppositePending.fired_at + 24 * 60 * 60 * 1000,
          asset_relevance: oppositePending.asset_relevance ?? 0,
          significance_score: oppositePending.significance_score ?? 0,
          conviction: oppositePending.confidence,
        };
        const verdict = resolveConflict(newCand, existingCand);
        if (verdict.kind === "suppress_new") {
          insertSuppressedSignal({
            suppressed_signal_data: {
              event_id: r.event_id,
              asset_id: primaryAssetId,
              direction,
              significance_score: significanceScore,
              conviction: finalConviction,
              tier,
            },
            reason: verdict.reason,
            conflicting_signal_id: verdict.winner_id,
            significance_loser: verdict.loser_significance,
            significance_winner: verdict.winner_significance,
          });
          // Loser never inserts. Continue to next event.
          continue;
        }
        if (verdict.kind === "suppress_existing") {
          Signals.markSuppressed(oppositePending.id, newSignalId);
          insertSuppressedSignal({
            suppressed_signal_data: { existing_signal_id: oppositePending.id },
            reason: verdict.reason,
            conflicting_signal_id: newSignalId,
            significance_loser: verdict.loser_significance,
            significance_winner: verdict.winner_significance,
          });
        } else if (verdict.kind === "supersede_existing") {
          Signals.markSupersededByConflict(oppositePending.id, newSignalId);
          insertSupersession({
            superseded_signal_id: oppositePending.id,
            superseding_signal_id: newSignalId,
            significance_ratio: verdict.ratio,
            reason: verdict.reason,
          });
        }
      }
    }

    // ── I-30 (Part 1): atomic signal + outcome insert ──
    // The signal row and its companion signal_outcomes row are created
    // in a single transaction. If the outcome insert fails (e.g. asset
    // class lookup returned null and we still tried to record one),
    // the signal insert rolls back too — no signal can persist without
    // a corresponding outcome stub. The outcome's `outcome` column
    // starts NULL; the resolution job fills it later.
    // Extract sodex_symbol once so the closure-boundary narrowing inside
    // `transaction(() => {...})` doesn't lose the non-null asserted earlier.
    const sodexSymbol = primaryAsset.tradable.symbol;

    // ── I-30 (Part 1) atomic insert of signal + outcome ──
    // The outcome row insert is INSIDE the same transaction as the
    // signal insert. If the outcome insert fails (e.g. a constraint
    // violation), the transaction throws and the signal insert rolls
    // back too — no signal can persist without a corresponding outcome
    // stub. AFTER the transaction commits, we verify both rows exist
    // and refuse with `outcome_record_failed` if not, as a defense for
    // any future code path that bypasses the transaction wrapper.
    //
    // I-45 — Every persisted signal MUST carry a non-null
    // significance_score. The significance pipeline must have run for
    // every emission path. Throw here rather than INSERT with NULL so
    // any future regression surfaces loudly instead of silently
    // bypassing the calibration pipeline.
    if (
      significanceScore == null ||
      !Number.isFinite(significanceScore as number)
    ) {
      throw new Error(
        `[signal-gen] I-45 violation: significance_score is ` +
          `null/non-finite for event=${r.event_id} asset=${primaryAssetId} ` +
          `subtype=${subtype} — significance pipeline must produce a score.`,
      );
    }
    transaction(() => {
      // Same-direction-same-asset supersession: a new stronger signal
      // retires the prior pending one on this asset+direction. Story-
      // level supersession: same UNDERLYING story (different primary
      // asset) — retires duplicate coverage on the dashboard.
      // BOTH must live inside this transaction so a downstream throw
      // (e.g. outcome insert failing) rolls them back along with the
      // insert. Pre-Phase-G these ran above the gate and persisted
      // even when the new signal didn't, producing phantom
      // supersessions referencing a UUID that never existed.
      if (opposite && opposite.confidence < conviction) {
        Signals.markSuperseded(opposite.id, newSignalId);
      }
      if (storyConflict && storyConflict.confidence < conviction) {
        Signals.markSuperseded(storyConflict.id, newSignalId);
      }
      Signals.insertSignal({
        id: newSignalId,
        triggered_by_event_id: r.event_id,
        pattern_id: null,
        asset_id: primaryAssetId,
        sodex_symbol: sodexSymbol,
        direction,
        tier,
        confidence: finalConviction,
        expected_impact_pct: null,
        expected_horizon: horizon,
        suggested_size_usd: size,
        suggested_stop_pct: stopPct,
        suggested_target_pct: targetPct,
        reasoning: enrichedReasoning,
        secondary_asset_ids:
          candidateAssets.length > 0 ? JSON.stringify(candidateAssets) : null,
        catalyst_subtype: subtype,
        expires_at: lifecycle.expires_at,
        corroboration_deadline: lifecycle.corroboration_deadline,
        event_chain_id: eventChainId,
        asset_relevance: preSave.asset_relevance,
        promotional_score: promo.score,
        source_tier: sourceTier,
        significance_score: significanceScore,
      });
      Outcomes.insertOutcomeFromSignal({
        signal_id: newSignalId,
        asset_class: assetClass ?? "unknown",
        price_at_generation: catalystPrice,
      });
    });
    // I-30 fallback assertion: confirm the outcome row landed. If it
    // didn't, throw — this exits the per-event loop before incrementing
    // `created` so the run summary stays honest.
    if (!Outcomes.outcomeExistsFor(newSignalId)) {
      console.error(
        `[signal-gen] I-30 violation: signal ${newSignalId} persisted without outcome row (outcome_record_failed)`,
      );
      throw new Error(
        `outcome_record_failed: signal ${newSignalId} has no signal_outcomes row`,
      );
    }
    created++;
    byTier[tier]++;
  }

  return {
    classifications_scanned: rows.length,
    signals_created: created,
    signals_skipped_no_tradable: skipNoTradable,
    signals_skipped_no_direction: skipNoDir,
    signals_skipped_below_threshold: skipBelow,
    signals_skipped_duplicate: skipDup,
    signals_skipped_not_actionable: skipNotActionable,
    signals_skipped_stale_event: skipStaleEvent,
    signals_skipped_stale_by_date: skipStaleByDate,
    signals_skipped_no_classification_v2: skipNoV2,
    signals_skipped_multi_asset_narrative: skipMultiAssetNarrative,
    signals_skipped_reasoning_contradiction: skipReasoningContradiction,
    by_tier: byTier,
    latency_ms: Date.now() - t0,
  };
}

export async function runSignalGenWithAudit(
  opts: { lookbackHours?: number } = {},
): Promise<SignalGenSummary & { run_id: number }> {
  const { id, data } = await Cron.recordRun("compute_patterns", async () => {
    const summary = await runSignalGen(opts);
    return {
      summary:
        `scanned=${summary.classifications_scanned} created=${summary.signals_created} ` +
        `auto=${summary.by_tier.auto} review=${summary.by_tier.review} info=${summary.by_tier.info}`,
      data: summary,
    };
  });
  return { ...(data as SignalGenSummary), run_id: id };
}
