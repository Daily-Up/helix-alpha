import { describe, expect, it } from "vitest";
import {
  validateTitle,
  sanitizeText,
} from "@/lib/pipeline/ingestion-validation";

describe("Bug class 7 — ingestion title validation", () => {
  describe("sanitizeText (HTML stripping + entity decoding)", () => {
    it("strips SoSoValue search-highlight spans verbatim", () => {
      const dirty =
        'Coinbase reported a <span style="color:#F00">net</span> ' +
        '<span style="color:#F00">loss</span> of $394 million';
      expect(sanitizeText(dirty)).toBe(
        "Coinbase reported a net loss of $394 million",
      );
    });
    it("decodes common entities", () => {
      expect(sanitizeText("Tom &amp; Jerry &lt;3 &quot;hi&quot;")).toBe(
        'Tom & Jerry <3 "hi"',
      );
    });
    it("normalizes whitespace and preserves $ and digits", () => {
      expect(sanitizeText("  $BTC   pumps   25%  ")).toBe("$BTC pumps 25%");
    });
    it("returns empty string on null/undefined", () => {
      expect(sanitizeText(null)).toBe("");
      expect(sanitizeText(undefined)).toBe("");
    });
  });

  describe("validateTitle", () => {
    it("rejects HTML left in the title (defense in depth)", () => {
      const r = validateTitle('Coinbase <span class="hl">Q1</span> miss');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("malformed_title");
    });

    it("rejects mid-sentence ellipsis truncation", () => {
      // SoSoValue commentary leaks: "...original text: Now there are se…"
      const r = validateTitle(
        "Seeing this report and also seeing an article from Bloomberg " +
          "Bloomberg's report is very detailed, original text: Now there are se…",
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("malformed_title");
    });

    it("rejects doubled source-name leak ('Bloomberg Bloomberg')", () => {
      const r = validateTitle(
        "Bloomberg Bloomberg report alleges WLFI conflicts of interest",
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("malformed_title");
    });

    it("rejects titles longer than 250 chars", () => {
      const r = validateTitle("a".repeat(260));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("malformed_title");
    });

    it("rejects empty / whitespace-only", () => {
      expect(validateTitle("").ok).toBe(false);
      expect(validateTitle("   ").ok).toBe(false);
    });

    it("rejects parser-artifact prefixes", () => {
      const r = validateTitle(
        'original text: "Coinbase missed Q1 estimates as crypto trading"',
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("malformed_title");
    });

    it("accepts a normal headline", () => {
      const r = validateTitle("Coinbase missed Q1 revenue estimates");
      expect(r.ok).toBe(true);
    });

    it("accepts emoji-prefixed but otherwise clean headlines", () => {
      const r = validateTitle("📉 Breaking: Coinbase reports $394M Q1 loss");
      expect(r.ok).toBe(true);
    });
  });
});
