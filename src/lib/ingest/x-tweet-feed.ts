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
 * Curated X accounts whose posts are worth running through the
 * classifier. The list is tight on purpose — each entry has to clear
 * one of four signal bars:
 *
 *   1. **Capital + policy** — institutional desk reporting, regulator
 *      actions, treasury company moves (BlackRock filings, SEC
 *      decisions, Saylor buys). Real money flows, not commentary.
 *   2. **First-mover on-chain** — large transfer alerts, whale moves,
 *      and on-chain investigators who post BEFORE editorial picks it up.
 *   3. **Hacks + exploits** — security firms that detect drains live.
 *   4. **Firm-size buying / selling** — corporate treasury actions,
 *      ETF flows, ARK / BlackRock / 21Shares-flavor disclosures.
 *
 * Commentary, analysis, KOL takes, and individual researchers are
 * deliberately excluded. They're often correct but they don't break
 * news — they react to it. Reacting to a reactor adds latency.
 *
 * Matching is case-insensitive substring on the SoSoValue author
 * field, so "WuBlockchain12", "wublockchain", and "wu_blockchain"
 * all match the entry "wublockchain".
 */
const TRUSTED_X_ACCOUNTS: readonly string[] = [
  // ── 1. Capital + policy (institutional newsrooms + regulators) ──
  "coindesk",            // CoinDesk — institutional reporting
  "theblock__",          // The Block — first to break Saylor / BlackRock filings
  "decryptmedia",
  "cointelegraph",       // covers SEC / regulatory actions
  "bloomberg",           // institutional breaking news
  "reuters",
  "wsj",
  "ftcrypto",            // FT crypto desk (umbrella "ft" too noisy)
  "financialtimes",
  "blockworks_",         // institutional crypto desk reporting

  // ── 2. First-mover on-chain (whale moves + investigators) ──
  "wublockchain",        // Wu Blockchain — Chinese-language scoops first
  "wublockchain12",
  "lookonchain",         // on-chain wallet tracking, breaks moves fast
  "whale_alert",         // automated large-transfer alerts
  "watcherguru",         // breaking institutional + macro headlines
  "zachxbt",             // on-chain investigations
  "spreekaway",          // on-chain sleuth

  // ── 3. Hacks + exploits (security firms with on-chain detection) ──
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
  "rektnews",            // Rekt — exploit post-mortems

  // ── 4. Firm-size buying / selling (treasury + ETF flow trackers) ──
  "saylor",              // MicroStrategy / Strategy
  "strategy",            // Strategy.com (Saylor's company)
  "blackrock",
  "fidelity",
  "arkinvest",           // ARK Invest disclosures
  "21shares",
  "grayscale",
  "bitwiseinvest",
  "vaneckcrypto",
  "hashdex",
  "purposeinvest",
  "valkyrieinvest",
];

/**
 * Title for trusted-account posts uses a longer cap (320 chars) so
 * we don't truncate Wu Blockchain's multi-line scoops mid-detail.
 */
const TRUSTED_TITLE_CAP = 320;
const DEFAULT_TITLE_CAP = 240;

/**
 * Minimum like-count for the blue-verified-with-asset fallback gate.
 * Tuned against live data (June 2026): 10 likes was too loose,
 * surfacing pure chart-commentary KOLs ("BTC bottoming signal").
 * 50 raises the bar to "this post has actual broadcast" — still
 * catches a new breaking-news account before we whitelist it, but
 * filters out shitposts that just happen to mention $BTC.
 */
const MIN_FALLBACK_LIKES = 50;

/**
 * Author handles whose every post is by definition crypto-relevant.
 * Bypasses the content-relevance gate below — when a security firm
 * tweets, it's because something on-chain happened. Same for whale
 * trackers — every tweet from whale_alert is a large transfer.
 */
const CONTENT_GATE_BYPASS = new Set<string>([
  "halborn", "peckshield", "peckshieldalert", "slowmist", "certik",
  "certikalert", "beosin", "cyvers", "hacken", "solidityscan",
  "blockaid", "rektnews",
  "whale_alert", "lookonchain",
]);

/**
 * Content-relevance regex. Even from trusted accounts like
 * Cointelegraph and Wu Blockchain, only a fraction of posts are
 * crypto-market relevant — the rest is general tech, political
 * commentary, or AI-policy content that has nothing to do with our
 * tradable universe.
 *
 * A tweet passes the content gate when its (title + content) text
 * contains at least one of:
 *
 *   - a crypto asset ticker or name (BTC, ETH, $XYZ, bitcoin, …)
 *   - a regulator + crypto-relevant context (SEC, CFTC, FCA, MAS)
 *   - ETF flow / spot-ETF mentions
 *   - a major exchange (Binance, Coinbase, Kraken, OKX, Bybit, …)
 *   - an exploit verb (hack, exploit, drained, stolen, rug)
 *   - a market-structure event (listing, delisting, halving, fork)
 *   - a treasury/ETF firm action (BlackRock, MicroStrategy, ARK, …)
 *   - macro/Fed events (FOMC, CPI, PCE, NFP, Beige Book, …)
 *
 * The list is broad on purpose: a false-positive ("we mention BTC in
 * passing") costs one Claude classification (~$0.001 on Haiku); a
 * false-negative (we drop the next "MSTR buys $2B BTC" post) costs
 * us the trade entirely. Tune toward recall.
 */
const RELEVANCE_PATTERNS: RegExp[] = [
  // Tickers (whole-word so "BTC" doesn't match "subtleBTCwithin")
  /\b(btc|eth|sol|xrp|bnb|ada|doge|avax|link|matic|dot|atom|near|arb|op|shib|pepe|uni|mkr|aave|bch|ltc|trx|fil|inj|tia|sei|jup|jto|wld|ena|ondo|pyth|render|tao)\b/i,
  // $ticker pattern
  /\$[A-Z]{2,6}\b/,
  // Asset names
  /\b(bitcoin|ethereum|solana|ripple|cardano|dogecoin|polygon|polkadot|chainlink|avalanche|hyperliquid|polymarket|kalshi)\b/i,
  // Categories
  /\b(crypto|cryptocurrenc|stablecoin|defi|cex|dex|perp(s|etual)?|tokeniz|on[- ]chain|altcoin|meme[- ]?coin)\b/i,
  // ETF / institutional product
  /\b(spot etf|futures etf|etf (flow|inflow|outflow)|net (inflow|outflow))/i,
  // Exchanges
  /\b(binance|coinbase|kraken|okx|bybit|hyperliquid|uniswap|gate\.io|kucoin|bitfinex|gemini|crypto\.com)\b/i,
  // Treasury / ETF firms
  /\b(microstrategy|strategy|blackrock|fidelity|ark invest|arkinvest|21shares|grayscale|bitwise|vaneck|hashdex|valkyrie|metaplanet|marathon|riot)\b/i,
  // Regulators (with crypto-relevant context within 50 chars)
  /\b(sec|cftc|fca|mas|finma|fincen|ofac|esma|treasury department)\b.{0,80}\b(crypto|token|bitcoin|ethereum|coin|digital asset|stablecoin|btc|eth|exchange)\b/i,
  /\b(crypto|token|bitcoin|ethereum|coin|digital asset|stablecoin|btc|eth|exchange)\b.{0,80}\b(sec|cftc|fca|mas|finma|fincen|ofac|esma)\b/i,
  // Macro / Fed
  /\b(fomc|federal reserve|fed|cpi|pce|nfp|nonfarm|beige book|powell|inflation|rate (hike|cut)|jobs report|treasury yield|10-?year)\b/i,
  // Exploit verbs
  /\b(hack|hacked|exploit|exploited|drained|stolen|theft|reentranc|flash loan|rug ?pull|compromis|phishing|sim swap)\b/i,
  // Market-structure events
  /\b(listing|delist|halving|fork|airdrop|launch (a |its )?token|unlock|tge|token (sale|launch))\b/i,
  // Capital actions
  /\b(filed|files|filing|approves|approved|rejects|rejected|sues|charges|settles|settled|halts|halted|seized|raises|raised)\b.{0,40}\b(crypto|token|bitcoin|ethereum|coin|btc|eth|etf|exchange|protocol|treasury)\b/i,
  /\b(crypto|token|bitcoin|ethereum|coin|btc|eth|etf|exchange|protocol|treasury)\b.{0,40}\b(filed|files|filing|approves|approved|rejects|sues|charges|settles|halts|seized|raises|raised|buy|buys|bought|sell|sells|sold|acquire|acquired)\b/i,
];

function passesContentRelevance(text: string): boolean {
  return RELEVANCE_PATTERNS.some((re) => re.test(text));
}

/** A NewsItem that carries the trusted-account flag we attach here. */
export type TweetItem = NewsItem & { is_trusted_x_account?: boolean };

function isTweet(item: NewsItem): boolean {
  return TWEET_CATEGORIES.has(item.category);
}

function isTrustedAccount(author: string | null | undefined): boolean {
  if (!author) return false;
  const a = author.toLowerCase();
  // Prefix-match, not substring. Substring matching allowed short
  // entries like "ft" (for FTCrypto) to false-positive on handles
  // like "NFTsAreNice" / "SwftCoin" / "MagicCraftGame" where "ft"
  // appears mid-string. Prefix match preserves the "WuBlockchain12"
  // → "wublockchain" case (entry is a prefix of the handle) while
  // rejecting the mid-string matches.
  return TRUSTED_X_ACCOUNTS.some((n) => a === n || a.startsWith(n));
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

    // VOLUME GATE — keep the feed at ~5-15 items/hour instead of 100+.
    // We accept a tweet only when ONE of these is true:
    //   (a) Author is on the trusted list (CoinDesk, Wu Blockchain,
    //       Halborn, etc.) — primary signal
    //   (b) The author is blue-verified AND the tweet mentions a
    //       tradable asset (matched_currencies non-empty) AND it has
    //       at least MIN_FALLBACK_LIKES likes — a safety net so a new
    //       Halborn-class breaker we haven't whitelisted yet doesn't
    //       get silently dropped
    // Everything else is dropped before it touches the classifier.
    // is_blue_verified is typed boolean in NewsItem but the upstream
    // SoSoValue payload uses 0/1 for the stored event type; coerce
    // safely either way.
    const blue = Boolean(item.is_blue_verified);
    const passesFallback =
      blue &&
      (item.matched_currencies?.length ?? 0) > 0 &&
      (item.like_count ?? 0) >= MIN_FALLBACK_LIKES;
    if (!trusted && !passesFallback) continue;

    // CONTENT-RELEVANCE GATE — even trusted accounts post off-topic
    // content (Cointelegraph on AI policy, Wu Blockchain on Tesla,
    // etc.). Reject tweets whose text doesn't match the crypto-/
    // macro-relevance patterns. Security firms + on-chain trackers
    // bypass — when they tweet, it's relevant by definition.
    const authorLower = (item.author ?? "").toLowerCase();
    const bypassContent = [...CONTENT_GATE_BYPASS].some(
      (a) => authorLower === a || authorLower.startsWith(a),
    );
    if (!bypassContent) {
      const blob = `${item.title ?? ""}\n${item.content ?? ""}`;
      if (!passesContentRelevance(blob)) continue;
    }

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

/**
 * Public re-export — same crypto-relevance regex used by the ingest
 * pipeline. Lives here so the search_x_live agent tool can apply the
 * same noise filter without re-implementing the patterns.
 */
export function isCryptoRelevantText(text: string): boolean {
  return passesContentRelevance(text);
}

export const _internals = {
  TRUSTED_X_ACCOUNTS,
  TWEET_CATEGORIES,
  CONTENT_GATE_BYPASS,
  isTweet,
  isTrustedAccount,
  passesContentRelevance,
  synthesiseTitle,
};
