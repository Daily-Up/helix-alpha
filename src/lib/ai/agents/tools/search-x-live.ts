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
import { isTrustedXAccount } from "@/lib/ingest/x-tweet-feed";
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
   * relevance sort) doesn't pollute the agent's reasoning. Default: 12.
   */
  max_age_hours?: number;
  /** Only include tweets from the curated trusted-account whitelist
   *  (security firms, WuBlockchain, watcherguru, etc.). Default true. */
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
      "Wu Blockchain's latest take on a regulatory headline. By default " +
      "filters to a curated trusted-account whitelist (security firms, " +
      "WuBlockchain, watcherguru, lookonchain, zachxbt, etc.) so you " +
      "don't get random KOL chatter.",
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
            "Drop tweets older than this. Defaults to 12. Lower (1-3) " +
            "for live exploit / breaking-news verification.",
        },
        trusted_only: {
          type: "boolean",
          description:
            "When true (default), keeps only tweets from the curated " +
            "trusted-account list. Flip to false to see all results — " +
            "useful when investigating a brand-new protocol the trust " +
            "list doesn't cover yet.",
        },
      },
    },
  },
  async handle(input) {
    const maxAgeHours = input.max_age_hours ?? 12;
    const trustedOnly = input.trusted_only ?? true;
    const cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000;

    let raw;
    try {
      raw = await News.searchNews({
        keyword: input.query,
        page_size: 50,
        sort: "publish_time",
      });
    } catch (err) {
      return {
        query: input.query,
        scanned: 0,
        matched_count: 0,
        results: [],
        summary: `Live X search failed: ${(err as Error).message}`,
      };
    }

    const items = raw.list ?? [];
    const tweets: Tweet[] = [];
    for (const it of items) {
      if (!TWEET_CATEGORIES.has(it.category)) continue;
      if (Number(it.release_time) < cutoffMs) continue;
      const author = String(it.author ?? "");
      const trusted = isTrustedXAccount(author);
      if (trustedOnly && !trusted) continue;
      const content = stripHtml(String(it.content ?? ""));
      if (!content) continue;
      tweets.push({
        released_iso: new Date(Number(it.release_time)).toISOString(),
        author,
        is_trusted: trusted,
        content: content.length > 320 ? content.slice(0, 320) + "…" : content,
      });
      if (tweets.length >= MAX_RESULTS) break;
    }

    const trustedHits = tweets.filter((t) => t.is_trusted).length;
    let summary: string;
    if (tweets.length === 0) {
      summary =
        `No matching tweets in the last ${maxAgeHours}h for "${input.query}"` +
        (trustedOnly ? " from trusted accounts" : "") +
        ". Either the story hasn't hit X yet or it's outside the corpus we trust.";
    } else {
      const authors = [...new Set(tweets.map((t) => `@${t.author}`))].slice(0, 5);
      summary =
        `${tweets.length} tweets in the last ${maxAgeHours}h ` +
        `(${trustedHits} from trusted accounts): ${authors.join(", ")}` +
        (tweets.length > authors.length ? ` + ${tweets.length - authors.length} more` : "") +
        `. Most recent: "${tweets[0].content.slice(0, 120)}…"`;
    }

    return {
      query: input.query,
      scanned: items.length,
      matched_count: tweets.length,
      results: tweets,
      summary,
    };
  },
};
