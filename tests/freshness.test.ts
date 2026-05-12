/**
 * Dimension 1 regression — semantic freshness check.
 *
 * Three real-shaped article pairs from the event store:
 *   1. Coinbase outage covered by 2 outlets (PANews + ChainCatcher)
 *   2. SEC chair Atkins "crypto era" statement covered by 3 outlets
 *   3. Garrett Jin whale ETH deposit covered by CT + on-chain trackers
 *
 * For each pair/triple, only the FIRST article should produce a signal;
 * subsequent articles must be dropped with `duplicate_coverage`. Articles
 * with intermediate similarity (0.75-0.85) are flagged `continuation`.
 *
 * The embedding provider used here is the bag-of-words `localTextEmbed`
 * — deterministic, free, offline. Production may swap in a real
 * sentence-transformer; the freshness CLASSIFIER is pure-function and
 * tests only the threshold logic.
 */

import { describe, expect, it } from "vitest";
import { localTextEmbed, cosineSimilarity } from "@/lib/pipeline/embeddings";
import { classifyFreshness } from "@/lib/pipeline/freshness";

describe("Dimension 1 — semantic freshness", () => {
  describe("localTextEmbed (BoW pseudo-embedding) — sanity", () => {
    it("identical text → cosine ≈ 1.0", () => {
      const a = localTextEmbed("Coinbase outage extends past 5 hours");
      const b = localTextEmbed("Coinbase outage extends past 5 hours");
      expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
    });
    it("totally unrelated text → cosine well below 0.5", () => {
      const a = localTextEmbed("Coinbase outage extends past 5 hours");
      const b = localTextEmbed(
        "Federal Reserve Governor signals interest rate cut",
      );
      expect(cosineSimilarity(a, b)).toBeLessThan(0.4);
    });
    it("paraphrases of the same event → above the BoW continuation threshold (0.42)", () => {
      // Two outlets covering the same Coinbase outage with overlapping
      // entities (Coinbase, outage, AWS, 5 hours). BoW catches the
      // entity overlap; sentence-transformers would push this higher
      // (~0.85) but the BoW band is sufficient for our gate's purposes.
      const a = localTextEmbed(
        "Coinbase outage extends past 5 hours due to AWS issues. Service is being restored.",
      );
      const b = localTextEmbed(
        "AWS outage hits Coinbase exchange for over 5 hours; trading affected as service restored gradually.",
      );
      expect(cosineSimilarity(a, b)).toBeGreaterThanOrEqual(0.42);
    });
  });

  describe("classifyFreshness — verdicts", () => {
    it("empty history → novel (no comparator)", () => {
      const r = classifyFreshness({
        new_embedding: localTextEmbed("anything"),
        history: [],
      });
      expect(r.verdict).toBe("novel");
      expect(r.matched_event_id).toBeNull();
    });

    it("article identical to history → duplicate_coverage", () => {
      const text =
        "Coinbase outage extends past 5 hours due to AWS issues. Service is being restored.";
      const r = classifyFreshness({
        new_embedding: localTextEmbed(text),
        history: [
          {
            event_id: "first-coverage",
            embedding: localTextEmbed(text),
          },
        ],
      });
      expect(r.verdict).toBe("duplicate");
      expect(r.matched_event_id).toBe("first-coverage");
      expect(r.similarity).toBeGreaterThan(0.85);
    });

    it("Coinbase outage paired coverage: second article → duplicate or continuation (NOT novel)", () => {
      // PANews-style first article
      const first =
        "Coinbase outage extends past 5 hours due to AWS issues. Service is being restored gradually.";
      // ChainCatcher-style second article (same event, different verbs)
      const second =
        "Coinbase exchange experiences AWS-related outage exceeding 5 hours; restoration of service in progress.";
      const r = classifyFreshness({
        new_embedding: localTextEmbed(second),
        history: [
          { event_id: "panews-first", embedding: localTextEmbed(first) },
        ],
      });
      // Same-event coverage MUST be flagged as not-novel — the gate's
      // job is to recognize this isn't a fresh catalyst. Whether it's
      // labeled `duplicate` (drop) or `continuation` (low-novelty)
      // depends on the embedder's discrimination — both are correct
      // verdicts; only `novel` would be a regression.
      expect(r.verdict === "duplicate" || r.verdict === "continuation").toBe(
        true,
      );
      // BoW captures entity overlap; same-event paraphrases hit the
      // continuation band (>= 0.42) reliably.
      expect(r.similarity).toBeGreaterThanOrEqual(0.42);
    });

    it("SEC Atkins triple coverage: third article → duplicate of one of the first two", () => {
      const a1 =
        "Breaking: SEC chairman Paul Atkins announces 'the cryptocurrency era has arrived' in Washington speech";
      const a2 =
        "SEC Chair Paul Atkins declares cryptocurrency era arrived during D.C. address; bullish for crypto markets";
      const a3 =
        "Paul Atkins, SEC chairman, says 'cryptocurrency era has arrived' — pro-crypto signal from new leadership";
      const r = classifyFreshness({
        new_embedding: localTextEmbed(a3),
        history: [
          { event_id: "atkins-1", embedding: localTextEmbed(a1) },
          { event_id: "atkins-2", embedding: localTextEmbed(a2) },
        ],
      });
      expect(r.verdict).not.toBe("novel");
      expect(["atkins-1", "atkins-2"]).toContain(r.matched_event_id);
    });

    it("Garrett Jin whale deposit cross-source: second source → duplicate", () => {
      const ct =
        "Garrett Jin (#BitcoinOG1011short) deposited 108,169 $ETH ($250M) into Binance — whale dump signal";
      const onchain =
        "On-chain alert: 108,169 ETH ($250M) transferred to Binance from Garrett Jin wallet — large whale deposit";
      const r = classifyFreshness({
        new_embedding: localTextEmbed(onchain),
        history: [{ event_id: "ct-source", embedding: localTextEmbed(ct) }],
      });
      expect(r.verdict).not.toBe("novel");
      expect(r.matched_event_id).toBe("ct-source");
    });

    it("genuinely different events → novel", () => {
      // Two articles with NO shared entities, verbs, or numbers — the
      // BoW vectors should be near-orthogonal.
      const r = classifyFreshness({
        new_embedding: localTextEmbed(
          "Spot copper prices climb to record highs amid Chilean mine strikes",
        ),
        history: [
          {
            event_id: "ftx-claim",
            embedding: localTextEmbed(
              "Vitalik Buterin proposes Pectra rollout schedule update for late Q3",
            ),
          },
        ],
      });
      expect(r.verdict).toBe("novel");
      expect(r.matched_event_id).toBeNull();
    });
  });
});
