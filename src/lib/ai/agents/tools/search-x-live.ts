/**
 * search_x_live tool.
 *
 * Live X/Twitter search against SoSoValue at agent runtime — bypasses
 * the news_events cache so the agent can ask "what's being tweeted
 * RIGHT NOW about this exploit / token / event" even if our cron
 * hasn't yet ingested those tweets.
 *
 * Why this exists alongside `search_outlet_coverage`:
 *   - `search_outlet_coverage` searches our local DB (ingested
 *     tweets + editorial news). Fast, free, but lags the 5-min cron.
 *   - `search_x_live` hits SoSoValue's /news/search live and post-
 *     filters to tweet categories (4 Insights / 7 Announcement).
 *     Slower (one HTTP round trip), but sees tweets from the LAST
 *     FEW MINUTES — critical for live exploit verification, hot
 *     regulatory news, breaking corporate flow reports.
 *
 * Quality controls
 *   - Apply the same trusted-account whitelist as the ingest path
 *     so the agent doesn't reason over random KOL chatter.
 *   - Cap results at 10 most recent.
 *   - Strip HTML colour spans SoSoValue wraps highlighted terms in.
 *
 * Cost shape
 *   - One SoSoValue /news/search call per invocation, ~150-400ms.
 *   - Agent token cost is just the returned summary (a few hundred
 *     tokens). Way cheaper than `fetch_full_article`.
 */

import { News } from "@/lib/sosovalue";
import { isTrustedXAccount, isCryptoRelevantText } from "@/lib/ingest/x-tweet-feed";
import { sanitizeText } from "@/lib/pipeline/ingestion-validation";
import type { AgentTool } from "./types";

const TWEET_CATEGORIES = new Set<number>([4, 7]);
const MAX_RESULTS = 10;

interface Input {
  /** Keyword / token / handle to search. Examples: "Curve", "$ETH",
   *  "HalbornSecurity", "Bedrock". The SoSoValue /news/search endpoint
   *  uses substring matching across title + content. */
  query: string;
  /**
   * Cap on age in hours. Tweets older than this are dropped client-side
   * so a stale match (the same hack from last week showing up first by
   * relevance sort) doesn't pollute the agent's reasoning. Default: 24.
   */
  max_age_hours?: number;
  /** Trust mode — controls how aggressively noise gets filtered.
   *   "trusted_only"  — old behaviour, only the curated trust list.
   *                     Highest precision, lowest recall. Use this when
   *                     verifying breaking exploits with high stakes.
   *   "noise_filter"  — DEFAULT. Keyword-search with a crypto-relevance
   *                     content gate + blue-verified-or-engaged signal,
   *                     trusted accounts always pass. Good balance.
   *   "all"           — return everything the keyword search returned,
   *                     no filtering. Useful when you're sleuthing a
   *                     brand-new project the trust list / patterns
   *                     don't cover yet.
   */
  mode?: "trusted_only" | "noise_filter" | "all";
  /** Deprecated alias for mode='trusted_only'. Kept for back-compat. */
  trusted_only?: boolean;
}

interface Tweet {
  released_iso: string;
  author: string;
  is_trusted: boolean;
  content: string;
}

interface Output {
  query: string;
  scanned: number;
  matched_count: number;
  results: Tweet[];
  /** Plain-English summary for the agent's reasoning + audit trace. */
  summary: string;
}

function stripHtml(s: string): string {
  return sanitizeText(s) ?? s.replace(/<[^>]+>/g, " ");
}

export const searchXLiveTool: AgentTool<Input, Output> = {
  spec: {
    name: "search_x_live",
    description:
      "Live X/Twitter search against SoSoValue's tweet feed (categories " +
      "4 + 7). Use this when you need tweets from the LAST FEW MINUTES " +
      "that may not yet be in our ingested corpus — e.g. checking if " +
      "Halborn/PeckShield/SlowMist has confirmed an exploit, or pulling " +
      "Wu Blockchain's latest take on a regulatory headline. Pass " +
      "ONE keyword (a token, a ticker, a protocol name, or a handle) — " +
      "the SoSoValue search is substring-based so longer phrases match " +
      "very little. By default (mode='noise_filter') trusted accounts " +
      "always pass and untrusted accounts must clear a crypto-relevance " +
      "regex + an engagement floor (blue OR 10+ likes), so you get " +
      "actual signal even from accounts not on the trust list. Use " +
      "mode='trusted_only' for high-stakes exploit verification.",
    input_schema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description:
            "Keyword / asset / protocol / handle to search. " +
            "Substring match across tweet title + content.",
        },
        max_age_hours: {
          type: "integer",
          description:
            "Drop tweets older than this. Defaults to 24. Lower (1-3) " +
            "for live exploit / breaking-news verification; raise (48-72) " +
            "for slower-moving regulatory / institutional flow stories.",
        },
        mode: {
          type: "string",
          enum: ["trusted_only", "noise_filter", "all"],
          description:
            "trusted_only: only the curated trust list (Halborn, Wu " +
            "Blockchain, CoinDesk, …). Highest precision, lowest recall. " +
            "noise_filter (DEFAULT): keyword search + crypto-relevance + " +
            "engagement floor; trusted accounts always pass. all: no " +
            "filtering — every tweet matching the keyword, useful for " +
            "investigating brand-new projects.",
        },
        trusted_only: {
          type: "boolean",
          description:
            "DEPRECATED — use mode='trusted_only' instead. Kept for " +
            "back-compat: if true, equivalent to mode='trusted_only'.",
        },
      },
    },
  },
  async handle(input) {
    const maxAgeHours = input.max_age_hours ?? 24;
    // Resolve mode: explicit `mode` wins, fall back to legacy
    // `trusted_only`, otherwise default to the noise-filter middle path.
    const mode: "trusted_only" | "noise_filter" | "all" =
      input.mode ??
      (input.trusted_only === true ? "trusted_only" : "noise_filter");
    const cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000;
    const MIN_LIKES_FOR_UNTRUSTED = 10;

    // Build a sequence of progressively-broader queries to try if the
    // original returns 0 tweets. SoSoValue uses substring matching,
    // so an agent passing the entire headline ("Coinbase SpaceX
    // futures") will match almost nothing — but "Coinbase" alone
    // matches plenty. This auto-broadening keeps the tool useful even
    // when the agent prompts it poorly.
    const tryQueries = [input.query];
    const words = input.query
      .split(/\s+/)
      .filter((w) => w.length >= 3)
      .filter((w) => !/^(the|and|for|with|from|that|this)$/i.test(w));
    if (words.length > 1) tryQueries.push(words[0]);
    if (words.length > 2) tryQueries.push(`${words[0]} ${words[1]}`);

    let scanned = 0;
    let usedQuery = input.query;
    let tweets: Tweet[] = [];

    for (const q of tryQueries) {
      let raw;
      try {
        raw = await News.searchNews({
          keyword: q,
          page_size: 50,
          sort: "publish_time",
        });
      } catch (err) {
        // Network failure on the first query — bail. Don't retry
        // because it's likely a SoSoValue outage, not a query issue.
        return {
          query: input.query,
          scanned: 0,
          matched_count: 0,
          results: [],
          summary: `Live X search failed: ${(err as Error).message}`,
        };
      }

      const items = raw.list ?? [];
      scanned += items.length;
      tweets = [];
      for (const it of items) {
        if (!TWEET_CATEGORIES.has(it.category)) continue;
        if (Number(it.release_time) < cutoffMs) continue;
        const author = String(it.author ?? "");
        const trusted = isTrustedXAccount(author);
        const content = stripHtml(String(it.content ?? ""));
        if (!content) continue;

        // Mode-specific filtering. Trusted authors always pass — their
        // tweets are by definition signal. Untrusted authors face a
        // gate that varies by mode.
        let passes: boolean;
        if (mode === "all" || trusted) {
          passes = true;
        } else if (mode === "trusted_only") {
          passes = false; // already-trusted handled above
        } else {
          // mode === "noise_filter" — the default. Untrusted authors
          // must clear both bars:
          //   1. The content mentions a crypto-relevant token /
          //      protocol / regulator / market event (regex from
          //      x-tweet-feed.ts — same noise gate the ingest uses).
          //   2. The post has some broadcast signal: either the
          //      author is blue-verified or it has ≥10 likes. A
          //      random anon tweet with 0 engagement that happens to
          //      mention 'BTC' is the kind of noise we drop.
          const relevant = isCryptoRelevantText(
            `${it.title ?? ""}\n${content}`,
          );
          if (!relevant) {
            passes = false;
          } else {
            const blue = Boolean(it.is_blue_verified);
            const likes = Number(it.like_count ?? 0);
            passes = blue || likes >= MIN_LIKES_FOR_UNTRUSTED;
          }
        }
        if (!passes) continue;

        tweets.push({
          released_iso: new Date(Number(it.release_time)).toISOString(),
          author,
          is_trusted: trusted,
          content: content.length > 320 ? content.slice(0, 320) + "…" : content,
        });
        if (tweets.length >= MAX_RESULTS) break;
      }

      usedQuery = q;
      if (tweets.length > 0) break; // got something, stop broadening
    }

    const trustedHits = tweets.filter((t) => t.is_trusted).length;
    let summary: string;
    if (tweets.length === 0) {
      const modeNote =
        mode === "trusted_only"
          ? " from trusted accounts only"
          : mode === "noise_filter"
            ? " that cleared the crypto-relevance + engagement gate"
            : "";
      summary =
        `No matching tweets in the last ${maxAgeHours}h for "${input.query}"` +
        (usedQuery !== input.query ? ` (also tried "${usedQuery}")` : "") +
        `${modeNote}. Consider widening max_age_hours, ` +
        `switching mode to "all" if hunting a brand-new project, or ` +
        `trying a shorter single-word keyword (ticker / handle / token).`;
    } else {
      const authors = [...new Set(tweets.map((t) => `@${t.author}`))].slice(0, 5);
      const broadened = usedQuery !== input.query ? ` (broadened to "${usedQuery}")` : "";
      summary =
        `${tweets.length} tweets in the last ${maxAgeHours}h${broadened} ` +
        `[mode=${mode}] ` +
        `(${trustedHits} trusted, ${tweets.length - trustedHits} ` +
        `${mode === "all" ? "untrusted" : "passed noise gate"}): ` +
        `${authors.join(", ")}` +
        (tweets.length > authors.length ? ` + ${tweets.length - authors.length} more` : "") +
        `. Most recent: "${tweets[0].content.slice(0, 120)}…"`;
    }

    return {
      query: input.query,
      scanned,
      matched_count: tweets.length,
      results: tweets,
      summary,
    };
  },
};
