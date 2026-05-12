/**
 * Stage 2 — Digest / roundup detection.
 *
 * "Crypto One Liners" articles bundle 5+ unrelated events into one
 * body. The classifier scores them as one signal on whichever ticker
 * happened to dominate the prompt's window — but the actual catalyst
 * is split across multiple unrelated stories.
 *
 * Strategy:
 *   1. Detect digests deterministically (title patterns + multi-ticker
 *      density heuristics).
 *   2. Block: digests don't reach the signal generator. They're flagged
 *      `is_digest=true` and dropped at the classification gate.
 *   3. (Future): split into per-event sub-articles via LLM extraction.
 *      For buildathon scope, we drop the article entirely.
 *
 * Companion tests: tests/digest.test.ts
 */

export interface DigestDetection {
  is_digest: boolean;
  reasons: string[];
}

const DIGEST_TITLE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "title_pattern_one_liners", re: /\bone\s+liners?\b/i },
  { name: "title_pattern_daily_wrap", re: /\bdaily\s+wrap\b/i },
  { name: "title_pattern_weekly_wrap", re: /\bweekly\s+wrap\b/i },
  { name: "title_pattern_daily_digest", re: /\bdaily\s+digest\b/i },
  { name: "title_pattern_weekly_digest", re: /\bweekly\s+digest\b/i },
  { name: "title_pattern_daily_newsletter", re: /\bdaily\s+newsletter\b/i },
  { name: "title_pattern_daily_roundup", re: /\bdaily\s+roundup\b/i },
  { name: "title_pattern_weekly_roundup", re: /\bweekly\s+roundup\b/i },
  { name: "title_pattern_news_digest", re: /\bnews\s+digest\b/i },
  { name: "title_pattern_news_roundup", re: /\bnews\s+roundup\b/i },
  { name: "title_pattern_today_in", re: /\btoday\s+in\s+crypto\b/i },
  { name: "title_pattern_crypto_briefing", re: /\bcrypto\s+briefing\b/i },
  { name: "title_pattern_morning_brief", re: /\bmorning\s+brief\b/i },
  { name: "title_pattern_evening_brief", re: /\bevening\s+brief\b/i },
  { name: "title_pattern_crypto_wrap", re: /\bcrypto\s+wrap\b/i },
  { name: "title_pattern_recap", re: /\brecap\s*[:|]/i },
];

/**
 * Count distinct $TICKER mentions in the title (e.g., $BTC, $ETH).
 * 3+ distinct tickers in one title is a strong digest signal.
 */
function countDistinctDollarTickers(title: string): number {
  const matches = title.match(/\$([A-Z][A-Z0-9]{0,9})\b/g) ?? [];
  return new Set(matches.map((m) => m.toUpperCase())).size;
}

export function detectDigest(input: {
  title: string;
  content: string | null;
}): DigestDetection {
  const reasons: string[] = [];
  const t = (input.title || "").trim();
  if (!t) return { is_digest: false, reasons };

  // 1. Title-pattern matches.
  for (const p of DIGEST_TITLE_PATTERNS) {
    if (p.re.test(t)) reasons.push(p.name);
  }

  // 2. Multi-ticker density. 3+ distinct $TICKER tags in one title is a
  //    digest signature.
  const dollarTickerCount = countDistinctDollarTickers(t);
  if (dollarTickerCount >= 3) {
    reasons.push(`multi_ticker_density_${dollarTickerCount}`);
  }

  // 3. List markers like "1)", "1.", "•" within the title — strong
  //    indicator of bundled list-style content.
  if (/(?:\b\d\)|\b\d\.\s+|•|—\s+\w+\s+—)/.test(t)) {
    // The em-dash "—" pattern is common in news ("Coinbase — Q1 miss"),
    // so only count it as evidence if combined with something else.
    if (reasons.length > 0) reasons.push("list_markers_in_title");
  }

  return { is_digest: reasons.length > 0, reasons };
}
