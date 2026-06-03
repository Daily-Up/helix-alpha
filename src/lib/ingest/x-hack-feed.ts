/**
 * X/Twitter hack-and-exploit feed ingest.
 *
 * SoSoValue's `/news/search` endpoint returns hits across all
 * categories. Categories 4 (Insights) and 7 (Announcement) are
 * specifically X posts; we filter to those because X is the fastest
 * channel for live exploit detection (security firms post within
 * minutes of on-chain detection, ahead of editorial outlets).
 *
 * Two precision boosts on top of keyword search:
 *
 *   1. Known security accounts (HalbornSecurity, PeckShieldAlert,
 *      SlowMist_Team, CertiKAlert, Beosin_com, Cyvers_, zachxbt) are
 *      surfaced even with thin keyword overlap — their posts are
 *      near-zero false positive rate by construction.
 *
 *   2. False-positive rejection: "hack" appears in hackathon names
 *      ("BNB Hack", "Eth Hack Lisbon"), AI-trading-agent prize pools
 *      ("BNB HACK: AI Trading Agent Edition"), and post-mortems much
 *      later than the actual event. We reject items whose content
 *      contains hackathon/prize-pool/contest cues.
 *
 * Items returned by this function carry a synthesised title (tweets
 * lack titles in SoSoValue's schema) so they can flow into the same
 * pipeline as editorial news.
 */

import { News } from "@/lib/sosovalue";
import type { NewsItem } from "@/lib/sosovalue/types";
import { sanitizeText } from "@/lib/pipeline/ingestion-validation";

/** SoSoValue category id → tweet feed. */
const TWEET_CATEGORIES = new Set([4, 7]);

/** High-precision security accounts: their alerts are near-zero false rate. */
const SECURITY_AUTHORS = [
  "halborn",
  "peckshield",
  "slowmist",
  "certik",
  "beosin",
  "chainalysis",
  "cyvers",
  "hacken",
  "zachxbt",
  "rektnews",
  "spreekaway",
  "blockaid",
  "solidityscan",
  "officer_cia",
  "tayvano_",
];

/** Keywords to sweep via /news/search. */
const HACK_KEYWORDS = [
  "exploit",
  "hack",
  "drained",
  "stolen",
  "rug pull",
  "compromised",
  "flash loan attack",
  "reentrancy",
];

/**
 * Negative cues — when the content contains any of these, it's almost
 * certainly a hackathon, contest, or trading-agent prize pool rather
 * than a real exploit. Tightening this list is cheap and high-value.
 */
const FALSE_POSITIVE_CUES = [
  "hackathon",
  "hack:",
  "hack edition",
  "trading agent season",
  "prize pool",
  "$" /* sticky for "$36k", "$50k" prize-pool style mentions */ +
    " prize",
  "submission deadline",
  "won the hack",
  "winners of",
  "registered teams",
  "bnb hack",
  "eth hack",
  "hack the planet",
];

function isTweet(item: NewsItem): boolean {
  return TWEET_CATEGORIES.has(item.category);
}

function isSecurityAuthor(author: string | null | undefined): boolean {
  if (!author) return false;
  const a = author.toLowerCase();
  return SECURITY_AUTHORS.some((n) => a.includes(n));
}

function containsAny(text: string, cues: readonly string[]): boolean {
  const t = text.toLowerCase();
  return cues.some((c) => t.includes(c.toLowerCase()));
}

function passesFalsePositiveFilter(item: NewsItem): boolean {
  const blob = `${item.title ?? ""}\n${item.content ?? ""}`;
  return !containsAny(blob, FALSE_POSITIVE_CUES);
}

/**
 * Synthesise a usable title from a tweet's content. SoSoValue strips
 * the title field for tweets; we take the first sentence (or first 240
 * chars) and prepend the @handle so the audit UI shows clear sourcing.
 */
function synthesiseTitle(author: string | null, content: string): string {
  const clean = sanitizeText(content) ?? "";
  if (!clean) return "";
  const periodIdx = clean.search(/[.!?]\s/);
  const firstSentence =
    periodIdx > 0 && periodIdx < 240
      ? clean.slice(0, periodIdx + 1)
      : clean.slice(0, 240);
  const trimmed =
    firstSentence.length > 240 ? firstSentence.slice(0, 240) + "…" : firstSentence;
  const handle = author ? `@${author}` : "X";
  return `[${handle}] ${trimmed}`;
}

/**
 * Fetch recent hack/exploit-flavor X posts from SoSoValue. Returns
 * items patched with a synthesised title and oldest-first.
 *
 * `daysBack` is clamped to [1, 6] — SoSoValue rejects time ranges
 * that span exactly 7 days; 6 is safe.
 */
export async function fetchHackTweets(opts: {
  daysBack?: number;
  maxItems?: number;
}): Promise<NewsItem[]> {
  void opts.daysBack; // /news/search doesn't take a time window — its
  // sort=publish_time gives us recency. We post-filter by time on the
  // caller side via the cutoff in runNewsIngest.
  const maxItems = opts.maxItems ?? 200;

  let raw: NewsItem[];
  try {
    raw = await News.searchNewsMulti(HACK_KEYWORDS, {
      pageSize: 50,
      sort: "publish_time",
    });
  } catch (err) {
    console.warn(`[hack-feed] search failed: ${(err as Error).message}`);
    return [];
  }

  const filtered: NewsItem[] = [];
  for (const item of raw) {
    if (!isTweet(item)) continue;
    if (!passesFalsePositiveFilter(item)) continue;

    // The keyword match itself is a substring hit; we trust /news/search
    // here. Security-author posts are kept regardless.
    const isSec = isSecurityAuthor(item.author);
    if (!isSec) {
      // For non-security authors, require the matched keyword to appear
      // alongside an asset-impact cue (USD amount, "drained", "stolen",
      // "exploited") rather than as a metaphor.
      const blob = `${item.title ?? ""}\n${item.content ?? ""}`;
      const hasAmount = /\$\s*\d|(\d+\s*(million|m|billion|b))/i.test(blob);
      const hasDrain = /\b(drained|stolen|exploited|exploit|reentrancy|compromised)\b/i.test(blob);
      if (!hasAmount && !hasDrain) continue;
    }

    const title =
      item.title && item.title.trim().length > 0
        ? item.title
        : synthesiseTitle(item.author, item.content ?? "");
    if (!title) continue;

    filtered.push({ ...item, title });
  }

  filtered.sort((a, b) => Number(a.release_time) - Number(b.release_time));
  return filtered.slice(-maxItems);
}

export const _internals = {
  SECURITY_AUTHORS,
  HACK_KEYWORDS,
  FALSE_POSITIVE_CUES,
  isSecurityAuthor,
  passesFalsePositiveFilter,
  synthesiseTitle,
};
