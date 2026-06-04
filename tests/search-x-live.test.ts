/**
 * Tests for the search_x_live agent tool.
 *
 * Lock down the filter logic so a regression doesn't accidentally
 * let untrusted-account spam through OR drop fresh tweets.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NewsItem } from "@/lib/sosovalue/types";

// Stub the SoSoValue client so the test stays hermetic.
const searchNewsSpy = vi.fn<(args: unknown) => Promise<{ list: NewsItem[] }>>();
vi.mock("@/lib/sosovalue", () => ({
  News: {
    searchNews: (args: unknown) => searchNewsSpy(args),
  },
}));

import { searchXLiveTool } from "@/lib/ai/agents/tools/search-x-live";

function tweet(overrides: Partial<NewsItem>): NewsItem {
  return {
    id: overrides.id ?? Math.random().toString(),
    release_time: overrides.release_time ?? Date.now() - 60_000,
    title: overrides.title ?? "",
    content: overrides.content ?? "",
    author: overrides.author ?? "RandomKOL",
    source_link: overrides.source_link ?? null,
    original_link: overrides.original_link ?? null,
    category: overrides.category ?? 7,
    tags: overrides.tags ?? null,
    matched_currencies: overrides.matched_currencies ?? null,
    impression_count: overrides.impression_count ?? null,
    like_count: overrides.like_count ?? null,
    retweet_count: overrides.retweet_count ?? null,
    is_blue_verified: overrides.is_blue_verified ?? false,
  } as NewsItem;
}

describe("search_x_live", () => {
  beforeEach(() => {
    searchNewsSpy.mockReset();
  });

  it("returns only tweet-category items (drops cat=1 editorial)", async () => {
    searchNewsSpy.mockResolvedValueOnce({
      list: [
        tweet({ id: "1", category: 1, author: "CoinDesk", content: "Editorial story" }),
        tweet({ id: "2", category: 4, author: "WuBlockchain", content: "Tweet about Curve hack" }),
        tweet({ id: "3", category: 7, author: "HalbornSecurity", content: "We confirm the drain" }),
      ],
    });
    const r = await searchXLiveTool.handle({ query: "Curve" });
    expect(r.matched_count).toBe(2);
    expect(r.results.every((t) => t.author !== "CoinDesk")).toBe(true);
  });

  it("drops untrusted accounts when trusted_only=true (default)", async () => {
    searchNewsSpy.mockResolvedValueOnce({
      list: [
        tweet({ id: "1", category: 4, author: "anon_kol", content: "shitpost" }),
        tweet({ id: "2", category: 7, author: "WuBlockchain", content: "scoop" }),
      ],
    });
    const r = await searchXLiveTool.handle({ query: "x" });
    expect(r.matched_count).toBe(1);
    expect(r.results[0].author).toBe("WuBlockchain");
  });

  it("includes untrusted authors when trusted_only=false", async () => {
    searchNewsSpy.mockResolvedValueOnce({
      list: [
        tweet({ id: "1", category: 4, author: "anon_kol", content: "shitpost" }),
        tweet({ id: "2", category: 7, author: "WuBlockchain", content: "scoop" }),
      ],
    });
    const r = await searchXLiveTool.handle({ query: "x", trusted_only: false });
    expect(r.matched_count).toBe(2);
  });

  it("drops tweets older than max_age_hours", async () => {
    const oldTs = Date.now() - 24 * 60 * 60 * 1000; // 24h ago
    searchNewsSpy.mockResolvedValueOnce({
      list: [
        tweet({ id: "old", category: 7, author: "HalbornSecurity", content: "old alert", release_time: oldTs }),
        tweet({ id: "new", category: 7, author: "HalbornSecurity", content: "new alert", release_time: Date.now() - 60_000 }),
      ],
    });
    const r = await searchXLiveTool.handle({ query: "x", max_age_hours: 3 });
    expect(r.matched_count).toBe(1);
    expect(r.results[0].content).toContain("new alert");
  });

  it("survives SoSoValue search failure with a graceful summary", async () => {
    searchNewsSpy.mockRejectedValueOnce(new Error("HTTP 502 Bad Gateway"));
    const r = await searchXLiveTool.handle({ query: "x" });
    expect(r.matched_count).toBe(0);
    expect(r.summary.toLowerCase()).toContain("failed");
  });

  it("auto-broadens to the first keyword when the full phrase yields 0 trusted tweets", async () => {
    // Round 1: agent passes a long phrase, nothing matches the trust list
    searchNewsSpy.mockResolvedValueOnce({
      list: [
        tweet({ id: "1", category: 7, author: "RandomBlogger", content: "Coinbase SpaceX futures filings rumour" }),
      ],
    });
    // Round 2: tool auto-retries with just "Coinbase", trusted result appears
    searchNewsSpy.mockResolvedValueOnce({
      list: [
        tweet({ id: "2", category: 7, author: "CoinDesk", content: "Coinbase launches pre-IPO perpetual futures" }),
      ],
    });
    const r = await searchXLiveTool.handle({ query: "Coinbase SpaceX futures" });
    expect(searchNewsSpy).toHaveBeenCalledTimes(2);
    expect(r.matched_count).toBe(1);
    expect(r.results[0].author).toBe("CoinDesk");
    expect(r.summary).toContain('broadened to "Coinbase"');
  });

  it("does NOT auto-broaden when the original query already returns results", async () => {
    searchNewsSpy.mockResolvedValueOnce({
      list: [
        tweet({ id: "1", category: 7, author: "CoinDesk", content: "Coinbase SpaceX futures: real product, launching now" }),
      ],
    });
    const r = await searchXLiveTool.handle({ query: "Coinbase SpaceX futures" });
    expect(searchNewsSpy).toHaveBeenCalledTimes(1); // no broadening retry
    expect(r.matched_count).toBe(1);
    expect(r.summary).not.toContain("broadened");
  });

  it("strips HTML colour spans from content", async () => {
    searchNewsSpy.mockResolvedValueOnce({
      list: [
        tweet({
          id: "1",
          category: 7,
          author: "HalbornSecurity",
          content: 'Curve <span style="color:#F00">drained</span> via reentrancy',
        }),
      ],
    });
    const r = await searchXLiveTool.handle({ query: "Curve" });
    expect(r.results[0].content).not.toContain("<span");
    expect(r.results[0].content).toContain("drained");
  });

  it("flags is_trusted correctly per result", async () => {
    searchNewsSpy.mockResolvedValueOnce({
      list: [
        tweet({ id: "1", category: 7, author: "WuBlockchain", content: "trusted scoop" }),
        tweet({ id: "2", category: 7, author: "anon", content: "untrusted noise" }),
      ],
    });
    const r = await searchXLiveTool.handle({ query: "x", trusted_only: false });
    expect(r.matched_count).toBe(2);
    const wu = r.results.find((t) => t.author === "WuBlockchain");
    const anon = r.results.find((t) => t.author === "anon");
    expect(wu?.is_trusted).toBe(true);
    expect(anon?.is_trusted).toBe(false);
  });
});
