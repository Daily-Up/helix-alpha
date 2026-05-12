import { describe, expect, it } from "vitest";
import { detectDigest } from "@/lib/pipeline/digest";

describe("Bug class 6 — digest articles produce mushy aggregate signals", () => {
  it("flags 'Crypto One Liners' digest", () => {
    const r = detectDigest({
      title:
        "Crypto One Liners... DIVERSIFIED CRYPTO GLXY — Galaxy Digital 1W: +24.2%, Strong Q1 beat: adjusted EPS loss of $0.49 vs $0.95 exp. Circle earnings May 11. BitGo May 13. COIN job cuts. MARA M&A.",
      content: "",
    });
    expect(r.is_digest).toBe(true);
    expect(r.reasons).toContain("title_pattern_one_liners");
  });

  it("flags Daily Wrap / Daily Roundup", () => {
    expect(
      detectDigest({ title: "Daily Wrap: BTC, ETH, SOL all green", content: "" })
        .is_digest,
    ).toBe(true);
    expect(
      detectDigest({
        title: "Crypto Daily Roundup — May 8",
        content: "",
      }).is_digest,
    ).toBe(true);
  });

  it("flags articles with multiple distinct ticker mentions and list markers", () => {
    const r = detectDigest({
      title:
        "Today's Crypto Briefing: $BTC up 2%, $ETH flat, $SOL +5%, $AVAX seed round closes $12M",
      content: "",
    });
    expect(r.is_digest).toBe(true);
  });

  it("does NOT flag a single-event headline", () => {
    const r = detectDigest({
      title: "Coinbase missed Q1 revenue estimates",
      content: "",
    });
    expect(r.is_digest).toBe(false);
  });

  it("does NOT flag a tweet-length single subject", () => {
    const r = detectDigest({
      title: "📉 Breaking: Coinbase reports $394M Q1 net loss",
      content: "",
    });
    expect(r.is_digest).toBe(false);
  });

  it("does NOT flag a multi-asset macro headline (regulatory/etf)", () => {
    const r = detectDigest({
      title: "Bitcoin and Ethereum ETFs see record inflows on Friday",
      content: "",
    });
    expect(r.is_digest).toBe(false);
  });
});
