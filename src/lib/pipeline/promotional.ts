/**
 * Stage 2 — Promotional / shill language detector.
 *
 * Caps the conviction tier when an article reads like paid placement,
 * KOL hype, or project shilling rather than reporting.
 *
 * The detection is heuristic on purpose: if Bloomberg writes "BREAKING:
 * massive FOMC surprise!!!" we don't want to suppress them, so the cap
 * only applies when sourceTier > 1 (non-primary). Tier-1 sources (real
 * news orgs, official accounts) get a pass — they can be excited.
 *
 * Real example caught in May 2026:
 *   "Hands down the BIGGEST announcement from SUI..." → REVIEW 64% LONG
 *   The tone is shill-y, the source is CT (tier 2-3). Should cap at INFO.
 */

import type { PromotionalScore, SourceTier } from "./types";

/** Hyperbolic words common to crypto promo / KOL-style content. */
const HYPERBOLIC_WORDS = [
  "biggest",
  "massive",
  "groundbreaking",
  "huge",
  "explosive",
  "insane",
  "crazy",
  "incredible",
  "unbelievable",
  "revolutionary",
  "game-changer",
  "game changer",
  "epic",
  "monster",
  "absolute",
  "lifechanging",
  "life-changing",
  "to the moon",
  "moonshot",
  "unstoppable",
  "the next bitcoin",
  "100x",
  "1000x",
  "ape in",
  "send it",
];

/** Promo emoji set — appearing in clusters indicates shill content. */
const PROMO_EMOJI = ["🚀", "🔥", "💎", "🙌", "🌙", "💰", "📈", "⚡", "✨", "💯"];

export function scorePromotional(
  title: string,
  content: string | null,
): PromotionalScore {
  const reasons: string[] = [];
  let score = 0;

  const t = (title || "").trim();
  const body = (content || "").slice(0, 600);
  const haystack = `${t} ${body}`.trim();
  if (!haystack) return { score: 0, reasons: [] };

  // ── Caps-lock dominance ──
  // News headlines often start with a TICKER or short caps prefix.
  // Genuine shill content runs caps through entire phrases.
  const letters = haystack.replace(/[^a-zA-Z]/g, "");
  if (letters.length > 12) {
    const upperRatio =
      letters.replace(/[^A-Z]/g, "").length / letters.length;
    if (upperRatio > 0.5) {
      score += 0.5;
      reasons.push("caps_dominant");
    } else if (upperRatio > 0.35) {
      score += 0.25;
      reasons.push("caps_heavy");
    }
  }

  // ── Hyperbolic words ──
  const lower = haystack.toLowerCase();
  let hyperHits = 0;
  for (const w of HYPERBOLIC_WORDS) {
    if (lower.includes(w)) {
      hyperHits++;
      reasons.push(
        `hyperbolic_${w.replace(/\s+/g, "_").replace(/-/g, "_")}`,
      );
    }
  }
  if (hyperHits >= 2) score += 0.5;
  else if (hyperHits === 1) score += 0.3;

  // ── Emoji density ──
  let emojiCount = 0;
  for (const e of PROMO_EMOJI) {
    const matches = haystack.split(e).length - 1;
    emojiCount += matches;
  }
  // 1 promo emoji at the start = news convention, fine.
  // 2+ promo emojis OR a cluster of 3 of the same = shill.
  if (emojiCount >= 3) {
    score += 0.4;
    reasons.push("emoji_density");
  } else if (emojiCount === 2) {
    score += 0.15;
  }

  // ── Exclamation density ──
  const excls = (haystack.match(/!/g) || []).length;
  if (excls >= 3) {
    score += 0.3;
    reasons.push("exclamation_spam");
  }

  // ── Buy-action calls ──
  if (
    /\b(don'?t miss|last chance|buy now|ape in|degen play|easy x|guaranteed)\b/i.test(
      haystack,
    )
  ) {
    score += 0.35;
    reasons.push("call_to_action");
  }

  // ── Shill-amplifier phrases ──
  // "Hands down the X", "By far the most Y", "Without a doubt the Z" —
  // classic CT framing that pumps up an otherwise weak claim.
  if (
    /\b(hands\s+down|by\s+far|without\s+a\s+doubt|no\s+doubt|trust\s+me|believe\s+me|mark\s+my\s+words)\b/i.test(
      haystack,
    )
  ) {
    score += 0.25;
    reasons.push("amplifier_phrase");
  }

  return { score: Math.min(1, score), reasons };
}

/**
 * Apply the promotional cap to a tier.
 *
 * Rule: score >= 0.5 + sourceTier > 1 → cap at INFO.
 *       Tier-1 sources (Bloomberg / SEC / etc.) bypass the cap.
 *       Cap NEVER promotes — it can only downgrade.
 */
export function capTierForPromotional(
  tier: "auto" | "review" | "info",
  promo: PromotionalScore,
  sourceTier: SourceTier,
): "auto" | "review" | "info" {
  if (promo.score < 0.5) return tier;
  if (sourceTier === 1) return tier; // real news orgs can be excited
  return "info";
}
