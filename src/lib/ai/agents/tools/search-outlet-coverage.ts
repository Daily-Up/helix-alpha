/**
 * search_outlet_coverage tool.
 *
 * Given a headline (or a keyword phrase from it), find other recently
 * ingested news events that look like coverage of the same story.
 * "Looks like" = token-overlap Jaccard ≥ 0.4 against the headline.
 *
 * Why the agent wants this:
 *   - Distinguishes a "lone tweet" from a "story covered by Reuters,
 *     Bloomberg, and CoinDesk" — a major input for tier / corroboration.
 *   - Catches likely planted promo: if no one else covers it in 48h,
 *     it's probably not a real catalyst.
 *
 * Implementation: pulls the last 48h of news_events from Turso and runs
 * a JS-side token Jaccard. Fast (~2000 rows max), no external API call.
 */

import { all } from "@/lib/db";
import type { AgentTool } from "./types";

interface Input {
  query: string;
  /** Hours of news history to scan. Default 48. */
  window_hours?: number;
  /** Min Jaccard similarity to count as coverage. Default 0.40. */
  min_similarity?: number;
  /** Max matches to return. Default 8. */
  limit?: number;
}

interface Match {
  event_id: string;
  title: string;
  author: string | null;
  release_time_iso: string;
  similarity: number;
}

interface Output {
  query: string;
  window_hours: number;
  total_scanned: number;
  matches: Match[];
}

const STOPWORDS = new Set([
  "the","a","an","and","or","but","is","are","was","were","be","been",
  "of","to","in","on","at","by","for","with","as","from","about","into",
  "this","that","these","those","it","its","has","have","had","says",
  "said","reports","reportedly",
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/<[^>]+>/g, " ")
      .replace(/[^a-z0-9$\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export const searchOutletCoverageTool: AgentTool<Input, Output> = {
  spec: {
    name: "search_outlet_coverage",
    description:
      "Search recently ingested news_events for OTHER outlets covering " +
      "the same story as a given headline or query phrase. Use this to " +
      "decide whether a news item is corroborated (multiple credible " +
      "outlets) or stands alone (single source, possibly noise).",
    input_schema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description:
            "Headline text or key phrase. The tool extracts informative " +
            "tokens and finds events with similar token sets.",
        },
        window_hours: {
          type: "number",
          description: "How many hours back to search. Default 48.",
        },
        min_similarity: {
          type: "number",
          description: "Jaccard threshold 0-1. Default 0.40.",
        },
        limit: {
          type: "number",
          description: "Max matches to return. Default 8.",
        },
      },
    },
  },
  async handle(input) {
    const windowHours = input.window_hours ?? 48;
    const minSim = input.min_similarity ?? 0.4;
    const limit = input.limit ?? 8;
    const since = Date.now() - windowHours * 60 * 60 * 1000;

    const rows = await all<{
      id: string;
      title: string;
      author: string | null;
      release_time: number;
    }>(
      `SELECT id, title, author, release_time
       FROM news_events
       WHERE release_time >= ?
       ORDER BY release_time DESC
       LIMIT 2000`,
      [since],
    );

    const qTokens = tokenize(input.query);
    if (qTokens.size < 3) {
      return {
        query: input.query,
        window_hours: windowHours,
        total_scanned: rows.length,
        matches: [],
      };
    }

    const matches: Match[] = [];
    for (const r of rows) {
      const sim = jaccard(qTokens, tokenize(r.title));
      if (sim >= minSim) {
        matches.push({
          event_id: r.id,
          title: r.title,
          author: r.author,
          release_time_iso: new Date(r.release_time).toISOString(),
          similarity: Math.round(sim * 1000) / 1000,
        });
      }
    }
    matches.sort((a, b) => b.similarity - a.similarity);

    return {
      query: input.query,
      window_hours: windowHours,
      total_scanned: rows.length,
      matches: matches.slice(0, limit),
    };
  },
};
