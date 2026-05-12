import { describe, expect, it } from "vitest";
import {
  scoreReasoningHedge,
  scoreAnonymizedActor,
  capTierForReliability,
} from "@/lib/pipeline/reliability";

describe("Bug class C — classifier hedging language should cap tier", () => {
  describe("scoreReasoningHedge", () => {
    it("'title says X, body says Y' is a strong hedge (>=0.5)", () => {
      // Real example caught in May 2026: classifier flagged
      // "title says Hassett, body says Kudlow—likely NEC commentary"
      // and the signal still fired at REVIEW 67%.
      const r = scoreReasoningHedge(
        "White House economic advisor (note: title says Hassett, body says Kudlow—likely NEC commentary) states inflation not spiraling.",
      );
      expect(r.score).toBeGreaterThanOrEqual(0.5);
      expect(r.reasons).toContain("hedge:title_body_mismatch");
    });

    it("'rumored', 'unverified', 'unconfirmed' all trigger", () => {
      expect(
        scoreReasoningHedge("This is a rumored deal between A and B").score,
      ).toBeGreaterThanOrEqual(0.5);
      expect(
        scoreReasoningHedge("Unverified report of a $1B move").score,
      ).toBeGreaterThanOrEqual(0.5);
      expect(
        scoreReasoningHedge("Unconfirmed via a single tweet").score,
      ).toBeGreaterThanOrEqual(0.5);
    });

    it("'if confirmed' is a strong hedge (>=0.5)", () => {
      const r = scoreReasoningHedge(
        "UBS exit would be material if confirmed by a tier-1 outlet.",
      );
      expect(r.score).toBeGreaterThanOrEqual(0.5);
    });

    it("multiple weak hedges combine to cap", () => {
      // "appears to" (0.25) + "may be" (0.2) + "claims" (0.25) = 0.7 → cap
      const r = scoreReasoningHedge(
        "The article appears to suggest X, which may be a stretch — the report claims a $200M move.",
      );
      expect(r.score).toBeGreaterThanOrEqual(0.5);
    });

    it("a single weak hedge does NOT trigger (negative)", () => {
      const r = scoreReasoningHedge(
        "This appears to be a fresh catalyst with high conviction.",
      );
      expect(r.score).toBeLessThan(0.5);
    });

    it("clean reasoning produces score 0 (negative)", () => {
      const r = scoreReasoningHedge(
        "Coinbase Q1 earnings miss with shares down 9%. Clear earnings event with immediate market reaction.",
      );
      expect(r.score).toBe(0);
    });
  });
});

describe("Bug class D — anonymized-actor titles with specific dollar amounts", () => {
  describe("scoreAnonymizedActor", () => {
    it("\"Switzerland's largest bank dropped $1.12B bet\" → cap (>=0.5)", () => {
      // Real example: UBS exit rumor that sat in pending for 22h on a
      // single tweet. Tier-1 coverage of a $1B+ position change appears
      // within hours; if not, the story isn't going to materialize.
      const r = scoreAnonymizedActor(
        "Switzerland's largest bank has dropped a $1.12 billion bet on @Strategy",
      );
      expect(r.score).toBeGreaterThanOrEqual(0.5);
      expect(r.reasons).toContain("anon_descriptor");
      expect(r.reasons).toContain("specific_dollar_figure");
    });

    it("'A major hedge fund moved $500M into BTC' → cap", () => {
      const r = scoreAnonymizedActor(
        "A major hedge fund moved $500M into BTC overnight",
      );
      expect(r.score).toBeGreaterThanOrEqual(0.5);
    });

    it("'One of the largest pension funds invested $2B' → cap", () => {
      const r = scoreAnonymizedActor(
        "One of the largest pension funds invested $2B into BTC ETFs",
      );
      expect(r.score).toBeGreaterThanOrEqual(0.5);
    });

    it("'Unnamed whale deposited $80M ETH' → cap", () => {
      const r = scoreAnonymizedActor(
        "Unnamed whale deposited $80M ETH into Binance",
      );
      expect(r.score).toBeGreaterThanOrEqual(0.5);
    });

    it("'UBS dropped $1.12B bet on Strategy' → NO cap (named actor)", () => {
      // Named actor = verifiable = no cap regardless of dollar size.
      const r = scoreAnonymizedActor(
        "UBS has dropped a $1.12 billion bet on Strategy",
      );
      expect(r.score).toBe(0);
    });

    it("'BlackRock invested $200M into IBIT' → NO cap", () => {
      const r = scoreAnonymizedActor(
        "BlackRock invested $200M into IBIT during last week",
      );
      expect(r.score).toBe(0);
    });

    it("anonymized descriptor without dollar figure → mid score, NOT a cap", () => {
      // "Switzerland's largest bank held a position" — anonymized but no
      // specific number. Suspicious but not enough to suppress entirely.
      const r = scoreAnonymizedActor(
        "Switzerland's largest bank holds positions in tech stocks",
      );
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThan(0.5);
    });
  });
});

describe("capTierForReliability — combined tier cap", () => {
  it("hedge >= 0.5 + non-tier-1 source → cap to INFO", () => {
    const r = capTierForReliability(
      "review",
      { score: 0.6, reasons: ["hedge:title_body_mismatch"] },
      { score: 0, reasons: [] },
      2,
    );
    expect(r.tier).toBe("info");
    expect(r.capped).toBe(true);
  });

  it("anon >= 0.5 + non-tier-1 source → cap to INFO", () => {
    const r = capTierForReliability(
      "auto",
      { score: 0, reasons: [] },
      { score: 0.6, reasons: ["anon_descriptor", "specific_dollar_figure"] },
      2,
    );
    expect(r.tier).toBe("info");
    expect(r.capped).toBe(true);
  });

  it("tier-1 source bypasses the cap (Bloomberg can hedge)", () => {
    const r = capTierForReliability(
      "review",
      { score: 0.8, reasons: ["hedge:title_body_mismatch"] },
      { score: 0, reasons: [] },
      1,
    );
    expect(r.tier).toBe("review");
    expect(r.capped).toBe(false);
  });

  it("both scores mid (sum >= 0.5) also caps", () => {
    const r = capTierForReliability(
      "review",
      { score: 0.3, reasons: ["hedge:appears_to_be_rumor"] },
      { score: 0.3, reasons: ["anon_descriptor"] },
      3,
    );
    expect(r.tier).toBe("info");
    expect(r.capped).toBe(true);
  });

  it("INFO tier stays INFO (cap can't promote)", () => {
    const r = capTierForReliability(
      "info",
      { score: 0.9, reasons: [] },
      { score: 0.9, reasons: [] },
      3,
    );
    expect(r.tier).toBe("info");
    expect(r.capped).toBe(false);
  });

  it("clean signal stays at original tier", () => {
    const r = capTierForReliability(
      "auto",
      { score: 0, reasons: [] },
      { score: 0, reasons: [] },
      2,
    );
    expect(r.tier).toBe("auto");
    expect(r.capped).toBe(false);
  });
});
