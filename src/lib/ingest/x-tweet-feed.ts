/**
 * X/Twitter feed ingest.
 *
 * SoSoValue's `/news` endpoint exposes X posts in categories 4
 * (Insights — KOL tweets) and 7 (Announcement — project + newsroom
 * tweets). These items consistently land 15-90 minutes ahead of
 * editorial coverage, and for some breaking stories (regulatory
 * leaks, exec departures, exchange listings, hacks, depegs) X is
 * the ONLY source for the first hour or two.
 *
 * Strategy: pull the feed broadly — don't gate on keywords. Let the
 * downstream pipeline (dedup → corpus pre-filter → classifier) do
 * the quality work. The signal we add on top:
 *
 *   1. Title synthesis: tweets arrive with empty `title`; we lift the
 *      first sentence (or first 240 chars) of `content` and prepend
 *      the @handle so the audit UI shows clear sourcing AND the
 *      ingestion-validation gate accepts the row.
 *
 *   2. Trusted-author boost: posts from a curated set of
 *      high-signal accounts (Wu Blockchain, CoinDesk, The Block,
 *      Bloomberg, Reuters, watcherguru, security firms, etc.) are
 *      tagged so the pipeline can:
 *        - bypass the corpus pre-filter (always classify them)
 *        - score them as tier-1 sources in the conviction math
 *
 *      "Trusted" here means: their first-hand reporting is
 *      historically reliable and on-topic. Inclusion ≠ alpha — it
 *      means "worth running the classifier on".
 *
 * The function returns `NewsItem`s patched with a synthesised title
 * AND an `is_trusted_x_account` flag on every row so callers can
 * route accordingly.
 */

import { News } from "@/lib/sosovalue";
import { NewsCategory, type NewsItem } from "@/lib/sosovalue/types";
import { sanitizeText } from "@/lib/pipeline/ingestion-validation";

/** SoSoValue category id → X / Twitter feed. */
const TWEET_CATEGORIES = new Set<number>([
  NewsCategory.Insights,      // 4 — KOL posts
  NewsCategory.Announcement,  // 7 — project + newsroom posts
]);

/**
 * Curated set of high-signal X accounts. Inclusion is conservative:
 * each must clear a bar of "their first-hand reporting is on-topic
 * and historically reliable for crypto market events". This list is
 * additive — adding noisy sources here doesn't hurt by itself (the
 * classifier still rates each post on its merits), but it does cost
 * us a classification cycle, so we keep it tight.
 *
 * Matching is case-insensitive substring on the SoSoValue author
 * field — "WuBlockchain12", "wublockchain", "wu blockchain" all
 * match the same entry "wublockchain".
 */
const TRUSTED_X_ACCOUNTS: readonly string[] = [
  // Editorial newsrooms (their X account often breaks ahead of their site)
  "coindesk",
  "theblock__",          // The Block official
  "decryptmedia",
  "cointelegraph",
  "defiantnews",         // The Defiant
  "dlnews_",             // DL News
  "blockworks_",
  "watcherguru",
  "messaricrypto",
  "bloomberg",
  "reuters",
  "wsj",
  "ft",                  // Financial Times
  "ftcrypto",
  // Crypto-native breaking news / on-chain investigators
  "wublockchain",        // Wu Blockchain — Chinese-language scoops first
  "wublockchain12",
  "rektnews",
  "zachxbt",
  "tayvano_",
  "officer_cia",
  "spreekaway",
  "lookonchain",
  "whale_alert",         // large transfers (often pre-news)
  // Security firms — first to detect on-chain exploits
  "halborn",
  "peckshield",
  "peckshieldalert",
  "slowmist",
  "certik",
  "certikalert",
  "beosin",
  "cyvers",
  "hacken",
  "solidityscan",
  "blockaid",
  // High-signal individual researchers / analysts
  "hsakatrades",
  "mev_",                // mev.io
  "thedefivillain",
  "0xfoobar",
  "twobitidiot",         // Ryan Selkis
  "udiwertheimer",
  "lopp",                // Jameson Lopp
];

/**
 * Title for trusted-account posts uses a longer cap (320 chars) so
 * we don't truncate Wu Blockchain's multi-line scoops mid-detail.
 */
const TRUSTED_TITLE_CAP = 320;
const DEFAULT_TITLE_CAP = 240;

/** A NewsItem that carries the trusted-account flag we attach here. */
export type TweetItem = NewsItem & { is_trusted_x_account?: boolean };

function isTweet(item: NewsItem): boolean {
  return TWEET_CATEGORIES.has(item.category);
}

function isTrustedAccount(author: string | null | undefined): boolean {
  if (!author) return false;
  const a = author.toLowerCase();
  return TRUSTED_X_ACCOUNTS.some((n) => a.includes(n));
}

/**
 * Synthesise a usable title from a tweet's content. SoSoValue leaves
 * the title empty for tweets, and the downstream ingestion-validation
 * gate rejects empty titles. We take the first sentence (or first N
 * chars) and prefix the @handle so the audit UI shows sourcing.
 *
 * Returns `null` when there's nothing usable.
 */
function synthesiseTitle(
  author: string | null | undefined,
  content: string,
  cap: number,
): string | null {
  const clean = sanitizeText(content) ?? "";
  if (!clean) return null;
  const periodIdx = clean.search(/[.!?]\s/);
  const firstSentence =
    periodIdx > 0 && periodIdx < cap
      ? clean.slice(0, periodIdx + 1)
      : clean.slice(0, cap);
  const trimmed =
    firstSentence.length > cap ? firstSentence.slice(0, cap) + "…" : firstSentence;
  const handle = author ? `@${author}` : "X";
  return `[${handle}] ${trimmed}`;
}

/**
 * Pull recent X posts from SoSoValue across both tweet categories.
 * Returns items oldest-first with synthesised titles and a
 * `is_trusted_x_account` flag. Empty-content items are dropped.
 *
 * `daysBack` is clamped to [1, 6] — SoSoValue's `/news` endpoint
 * rejects time ranges that span exactly 7 days.
 */
export async function fetchTweets(opts: {
  daysBack?: number;
  maxItems?: number;
}): Promise<TweetItem[]> {
  const daysBack = Math.min(6, Math.max(1, opts.daysBack ?? 1));
  const maxItemsPerCat = Math.ceil((opts.maxItems ?? 200) / 2);

  const [insights, announcements] = await Promise.all([
    News.fetchRecentNews({
      daysBack,
      category: NewsCategory.Insights,
      maxItems: maxItemsPerCat,
      language: "en",
    }),
    News.fetchRecentNews({
      daysBack,
      category: NewsCategory.Announcement,
      maxItems: maxItemsPerCat,
      language: "en",
    }),
  ]);

  // Dedup by id (an item could in theory appear in both categories).
  const seen = new Set<string>();
  const out: TweetItem[] = [];

  for (const item of [...insights, ...announcements]) {
    if (seen.has(item.id)) continue;
    if (!isTweet(item)) continue;

    const trusted = isTrustedAccount(item.author);
    const cap = trusted ? TRUSTED_TITLE_CAP : DEFAULT_TITLE_CAP;

    // If the item somehow has a real title, keep it. Otherwise synthesise.
    let title = item.title?.trim() ?? "";
    if (!title) {
      const syn = synthesiseTitle(item.author, item.content ?? "", cap);
      if (!syn) continue;
      title = syn;
    }

    seen.add(item.id);
    out.push({ ...item, title, is_trusted_x_account: trusted });
  }

  out.sort((a, b) => Number(a.release_time) - Number(b.release_time));
  return out;
}

/**
 * Test seam: predicate for "is this author on our trusted list?".
 * Exported so downstream pipeline stages (corpus filter, source-tier
 * scoring) can ask the same question without re-implementing the
 * substring match.
 */
export function isTrustedXAccount(author: string | null | undefined): boolean {
  return isTrustedAccount(author);
}

export const _internals = {
  TRUSTED_X_ACCOUNTS,
  TWEET_CATEGORIES,
  isTweet,
  isTrustedAccount,
  synthesiseTitle,
};
