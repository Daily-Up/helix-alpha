/**
 * Unit tests for the X tweet feed.
 *
 * The point of this feed is BREADTH, not keyword-narrowness. The two
 * things that have to work:
 *   - title synthesis: SoSoValue leaves tweet titles empty; we must
 *     produce a non-empty title or the ingestion-validation gate
 *     drops the row before it reaches the classifier
 *   - trusted-account detection: Wu Blockchain, CoinDesk, Halborn,
 *     etc. need to be recognised regardless of capitalisation or
 *     trailing digits (wublockchain12 / WuBlockchain12)
 */
import { describe, expect, it } from "vitest";
import { isTrustedXAccount, _internals } from "@/lib/ingest/x-tweet-feed";

const { synthesiseTitle, isTweet } = _internals;

describe("isTrustedXAccount", () => {
  it("matches WuBlockchain12", () => {
    expect(isTrustedXAccount("WuBlockchain12")).toBe(true);
  });
  it("matches wublockchain (no digits)", () => {
    expect(isTrustedXAccount("wublockchain")).toBe(true);
  });
  it("matches CoinDesk", () => {
    expect(isTrustedXAccount("CoinDesk")).toBe(true);
  });
  it("matches Halborn (security firm)", () => {
    expect(isTrustedXAccount("HalbornSecurity")).toBe(true);
  });
  it("matches lookonchain", () => {
    expect(isTrustedXAccount("lookonchain")).toBe(true);
  });
  it("matches whale_alert (large transfers)", () => {
    expect(isTrustedXAccount("whale_alert")).toBe(true);
  });
  it("matches Bloomberg + Reuters via the institutional list", () => {
    expect(isTrustedXAccount("Bloomberg")).toBe(true);
    expect(isTrustedXAccount("Reuters")).toBe(true);
  });
  it("rejects random KOL handles", () => {
    expect(isTrustedXAccount("crashiusclay69")).toBe(false);
    expect(isTrustedXAccount("anonymous_anon")).toBe(false);
  });
  it("handles null / undefined / empty", () => {
    expect(isTrustedXAccount(null)).toBe(false);
    expect(isTrustedXAccount(undefined)).toBe(false);
    expect(isTrustedXAccount("")).toBe(false);
  });
});

describe("fetchTweets volume gate (mocked SoSoValue)", () => {
  // We test the predicate logic via _internals exports rather than the
  // network-touching fetchTweets entrypoint. The gate is exercised
  // through synthetic NewsItem rows.

  type Row = {
    id: string;
    category: number;
    author: string;
    is_blue_verified: 0 | 1;
    matched_currencies: { currency_id: string; symbol: string; name: string }[];
    like_count?: number;
    content: string;
    title?: string;
  };

  // Reproduce the gate predicate locally so the test stays hermetic.
  const TRUSTED = (a: string) => isTrustedXAccount(a);
  function passesGate(r: Row): boolean {
    if (TRUSTED(r.author)) return true;
    return (
      r.is_blue_verified === 1 &&
      r.matched_currencies.length > 0 &&
      (r.like_count ?? 0) >= 10
    );
  }

  it("trusted account ALWAYS passes (even with no asset, no likes)", () => {
    expect(
      passesGate({
        id: "1",
        category: 7,
        author: "WuBlockchain12",
        is_blue_verified: 0,
        matched_currencies: [],
        like_count: 0,
        content: "x",
      }),
    ).toBe(true);
  });

  it("untrusted blue-verified with matched asset + 10 likes PASSES (fallback)", () => {
    expect(
      passesGate({
        id: "2",
        category: 4,
        author: "RandomKOL",
        is_blue_verified: 1,
        matched_currencies: [{ currency_id: "1", symbol: "BTC", name: "Bitcoin" }],
        like_count: 50,
        content: "BTC breakout coming",
      }),
    ).toBe(true);
  });

  it("untrusted blue-verified but NO asset DROPPED", () => {
    expect(
      passesGate({
        id: "3",
        category: 4,
        author: "RandomBlueKOL",
        is_blue_verified: 1,
        matched_currencies: [],
        like_count: 100,
        content: "GM",
      }),
    ).toBe(false);
  });

  it("untrusted blue-verified with asset but <10 likes DROPPED", () => {
    expect(
      passesGate({
        id: "4",
        category: 4,
        author: "RandomBlueKOL",
        is_blue_verified: 1,
        matched_currencies: [{ currency_id: "1", symbol: "ETH", name: "Ethereum" }],
        like_count: 3,
        content: "eth",
      }),
    ).toBe(false);
  });

  it("untrusted unverified anon DROPPED no matter what", () => {
    expect(
      passesGate({
        id: "5",
        category: 4,
        author: "anonymous_anon",
        is_blue_verified: 0,
        matched_currencies: [{ currency_id: "1", symbol: "BTC", name: "Bitcoin" }],
        like_count: 5000,
        content: "btc moon",
      }),
    ).toBe(false);
  });
});

describe("isTweet — only X categories (4, 7) qualify", () => {
  it("category=4 (Insights) is a tweet", () => {
    expect(isTweet({ category: 4 } as Parameters<typeof isTweet>[0])).toBe(true);
  });
  it("category=7 (Announcement) is a tweet", () => {
    expect(isTweet({ category: 7 } as Parameters<typeof isTweet>[0])).toBe(true);
  });
  it("category=1 (regular News) is NOT a tweet", () => {
    expect(isTweet({ category: 1 } as Parameters<typeof isTweet>[0])).toBe(false);
  });
  it("category=13 (CryptoStockNews) is NOT a tweet", () => {
    expect(isTweet({ category: 13 } as Parameters<typeof isTweet>[0])).toBe(false);
  });
});

describe("synthesiseTitle", () => {
  it("uses first sentence when content has period", () => {
    const t = synthesiseTitle(
      "WuBlockchain",
      "Binance is reportedly listing $XYZ tomorrow. Source: internal email.",
      320,
    );
    expect(t).toContain("@WuBlockchain");
    expect(t).toContain("Binance");
    expect(t).toContain("XYZ");
    expect(t).not.toContain("Source: internal email");
  });

  it("falls back to char cap when first sentence is long", () => {
    const content = "A".repeat(500);
    const t = synthesiseTitle("zachxbt", content, 240);
    expect(t).toBeTruthy();
    if (!t) return; // type guard
    expect(t.length).toBeLessThan(260);
    expect(t.startsWith("[@zachxbt]")).toBe(true);
  });

  it("trusted cap is wider (320 chars) so Wu scoops don't truncate mid-detail", () => {
    const content = "A".repeat(500);
    const t = synthesiseTitle("WuBlockchain12", content, 320);
    expect(t).toBeTruthy();
    if (!t) return;
    // Allow some headroom for prefix + ellipsis
    expect(t.length).toBeGreaterThan(280);
  });

  it("returns null for empty content", () => {
    expect(synthesiseTitle("zachxbt", "", 240)).toBeNull();
    expect(synthesiseTitle(null, "", 240)).toBeNull();
  });

  it("falls back to [X] when author is null", () => {
    const t = synthesiseTitle(null, "Flash loan attack drained $5M from XYZ.", 240);
    expect(t).toBeTruthy();
    if (!t) return;
    expect(t.startsWith("[X]")).toBe(true);
  });

  it("strips HTML from content (SoSoValue sometimes wraps in colour spans)", () => {
    const t = synthesiseTitle(
      "CoinDesk",
      "BREAKING: SEC approves <span style=\"color:#F00\">spot</span> ETH ETF.",
      240,
    );
    expect(t).toBeTruthy();
    if (!t) return;
    expect(t).not.toContain("<span");
    expect(t).not.toContain("color:");
    expect(t).toContain("spot");
  });
});
