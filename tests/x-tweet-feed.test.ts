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
