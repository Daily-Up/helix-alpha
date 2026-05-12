import { describe, expect, it } from "vitest";
import {
  scorePromotional,
  capTierForPromotional,
} from "@/lib/pipeline/promotional";

describe("Bug class 8 — promotional language detection", () => {
  describe("scorePromotional", () => {
    it("flags caps-lock heavy text", () => {
      const r = scorePromotional("THIS IS A HUGE ANNOUNCEMENT FOR $SUI", "");
      expect(r.score).toBeGreaterThanOrEqual(0.5);
      expect(r.reasons).toContain("caps_dominant");
    });

    it("flags hyperbolic shill words", () => {
      const r = scorePromotional(
        "Hands down the BIGGEST announcement from SUI",
        "",
      );
      expect(r.score).toBeGreaterThanOrEqual(0.5);
      expect(r.reasons.some((x) => x.startsWith("hyperbolic_"))).toBe(true);
    });

    it("flags rocket/fire emoji density", () => {
      const r = scorePromotional("🚀🚀🚀 $SUI to the moon 🔥🔥", "");
      expect(r.score).toBeGreaterThanOrEqual(0.5);
      expect(r.reasons).toContain("emoji_density");
    });

    it("flags exclamation-spam", () => {
      const r = scorePromotional("BIG NEWS!!! Don't miss this!!! BUY $X NOW!!!", "");
      expect(r.score).toBeGreaterThanOrEqual(0.5);
    });

    it("does NOT flag a Bloomberg-style headline", () => {
      const r = scorePromotional(
        "Coinbase missed Q1 revenue estimates as crypto trading slides",
        "",
      );
      expect(r.score).toBeLessThan(0.5);
    });

    it("does NOT flag SEC primary-source statement", () => {
      const r = scorePromotional(
        "SEC chairman Atkins announces new framework for digital assets",
        "",
      );
      expect(r.score).toBeLessThan(0.5);
    });

    it("does NOT flag a single emoji at the start (news convention)", () => {
      const r = scorePromotional("📉 Coinbase reports Q1 net loss of $394M", "");
      expect(r.score).toBeLessThan(0.5);
    });
  });

  describe("capTierForPromotional", () => {
    it("downgrades to info when score >= 0.5 and source is tier 2/3", () => {
      const t = capTierForPromotional("auto", { score: 0.7, reasons: [] }, 2);
      expect(t).toBe("info");
    });
    it("does NOT downgrade tier-1 (Bloomberg) even if shill-y", () => {
      const t = capTierForPromotional(
        "auto",
        { score: 0.7, reasons: [] },
        1,
      );
      expect(t).toBe("auto");
    });
    it("leaves clean signals alone", () => {
      const t = capTierForPromotional(
        "auto",
        { score: 0.1, reasons: [] },
        2,
      );
      expect(t).toBe("auto");
    });
    it("never promotes — only caps", () => {
      const t = capTierForPromotional(
        "info",
        { score: 0.0, reasons: [] },
        1,
      );
      expect(t).toBe("info");
    });
  });
});
