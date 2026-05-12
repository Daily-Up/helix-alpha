/**
 * End-to-end test: run each adversarial fixture through the relevant
 * pipeline stages and assert the bad output does NOT occur.
 *
 * This is the regression suite the team should add to CI. Future
 * changes that weaken any bug-class fix will fail here BEFORE shipping.
 */

import { describe, expect, it } from "vitest";
import { FIXTURES } from "./adversarial-fixtures";
import {
  validateTitle,
  sanitizeText,
} from "@/lib/pipeline/ingestion-validation";
import { detectDigest } from "@/lib/pipeline/digest";
import { routeAssets } from "@/lib/pipeline/asset-router";
import {
  scorePromotional,
  capTierForPromotional,
} from "@/lib/pipeline/promotional";
import {
  inferCatalystSubtype,
  capForFundingMagnitude,
} from "@/lib/pipeline/catalyst-subtype";
import { computeLifecycle } from "@/lib/pipeline/lifecycle";
import { checkSignalInvariants } from "@/lib/pipeline/invariants";
import type { SourceTier } from "@/lib/pipeline/types";

// Mock candidate registry — minimum needed for routing tests.
const MOCK_CANDIDATES: Record<
  string,
  { asset_id: string; symbol: string; kind: string; tradable: boolean }
> = {
  "stk-coin": { asset_id: "stk-coin", symbol: "COIN", kind: "stock", tradable: true },
  "stk-iren": { asset_id: "stk-iren", symbol: "IREN", kind: "stock", tradable: false },
  "stk-nvda": { asset_id: "stk-nvda", symbol: "NVDA", kind: "stock", tradable: true },
  "trs-mstr": { asset_id: "trs-mstr", symbol: "MSTR", kind: "treasury", tradable: true },
  "tok-btc":  { asset_id: "tok-btc",  symbol: "BTC",  kind: "token",  tradable: true },
  "tok-eth":  { asset_id: "tok-eth",  symbol: "ETH",  kind: "token",  tradable: true },
  "tok-arb":  { asset_id: "tok-arb",  symbol: "ARB",  kind: "token",  tradable: true },
  "tok-aave": { asset_id: "tok-aave", symbol: "AAVE", kind: "token",  tradable: true },
  "tok-mnt":  { asset_id: "tok-mnt",  symbol: "MNT",  kind: "token",  tradable: false },
  "tok-sui":  { asset_id: "tok-sui",  symbol: "SUI",  kind: "token",  tradable: true },
  "tok-avax": { asset_id: "tok-avax", symbol: "AVAX", kind: "token",  tradable: true },
  "tok-wlfi": { asset_id: "tok-wlfi", symbol: "WLFI", kind: "token",  tradable: true },
  "idx-ssimag7": { asset_id: "idx-ssimag7", symbol: "ssimag7", kind: "index", tradable: true },
  "idx-ssirwa":  { asset_id: "idx-ssirwa",  symbol: "ssirwa",  kind: "index", tradable: true },
};

function sourceTierFor(author: string, blueVerified: boolean): SourceTier {
  const a = author.toLowerCase();
  if (
    /(bloomberg|reuters|wsj|cnbc|coindesk|theblock|sec\.gov)/i.test(a)
  ) return 1;
  if (blueVerified) return 2;
  return 3;
}

describe("Adversarial fixtures end-to-end", () => {
  for (const f of FIXTURES) {
    it(`${f.id}: ${f.description}`, () => {
      // ── Stage 1: ingestion ──
      const cleaned = sanitizeText(f.raw.title);
      const titleValid = validateTitle(cleaned);
      const passes_ingestion = titleValid.ok;

      if (f.must_not.pass_ingestion === true) {
        expect(passes_ingestion, `${f.id}: should NOT pass ingestion`).toBe(
          false,
        );
        return; // can't run further stages on rejected input
      }

      // ── Stage 2a: digest detection ──
      const digest = detectDigest({
        title: cleaned,
        content: f.raw.content,
      });
      if (f.must_not.pass_digest_gate === true) {
        expect(digest.is_digest, `${f.id}: should be flagged as digest`).toBe(
          true,
        );
        return; // digests are blocked, no signal
      }

      // ── Stage 2b: promotional scoring ──
      const promo = scorePromotional(cleaned, f.raw.content);
      const sourceTier = sourceTierFor(f.raw.author, f.raw.is_blue_verified);

      // ── Stage 3: asset routing ──
      const candidates = f.classification.affected_asset_ids
        .map((id) => MOCK_CANDIDATES[id])
        .filter(Boolean);
      const routed = routeAssets({
        title: cleaned,
        candidates,
        affected_asset_ids: f.classification.affected_asset_ids,
        event_type: f.classification.event_type,
      });

      // Assert the signal does NOT fire on the forbidden assets.
      if (f.must_not.fire_on) {
        for (const forbiddenId of f.must_not.fire_on) {
          expect(
            routed.primary?.asset_id,
            `${f.id}: must not fire on ${forbiddenId}`,
          ).not.toBe(forbiddenId);
        }
      }

      // ── Stage 5: catalyst subtype + risk ──
      const subtype = inferCatalystSubtype(f.classification.event_type, {
        title: cleaned,
        sentiment: f.classification.sentiment,
      });

      // ── Tier resolution (simplified) ──
      // Heuristic conviction = classifier_confidence × 0.8 (just for the
      // adversarial harness — the real scorer uses 7 axes). Tier from
      // settings defaults: auto >= 0.75, review >= 0.55.
      const conviction = f.classification.confidence * 0.8;
      let tier: "auto" | "review" | "info" =
        conviction >= 0.75 ? "auto" : conviction >= 0.55 ? "review" : "info";

      // Promotional cap.
      tier = capTierForPromotional(tier, promo, sourceTier);

      // Funding magnitude cap (Bug 2 — small VC rounds on big chains).
      if (f.classification.event_type === "fundraising") {
        // Approximate market cap for AVAX ~$5B as of fixture date; use it
        // as the conservative-but-realistic stand-in for the test harness.
        tier = capForFundingMagnitude(tier, {
          round_size_usd: 12_700_000,
          market_cap_usd:
            f.classification.affected_asset_ids[0] === "tok-avax"
              ? 5_000_000_000
              : null,
        });
      }

      if (f.must_not.tier_at_most) {
        const order: Record<string, number> = {
          info: 0,
          review: 1,
          auto: 2,
        };
        expect(
          order[tier],
          `${f.id}: tier=${tier} exceeds ${f.must_not.tier_at_most}`,
        ).toBeLessThanOrEqual(order[f.must_not.tier_at_most]);
      }

      // ── Stage 8: lifecycle ──
      const lifecycle = computeLifecycle({
        subtype,
        generated_at: Date.now(),
        source_tier: sourceTier,
      });
      // Sanity: expires_at always in the future.
      expect(lifecycle.expires_at).toBeGreaterThan(Date.now());

      // ── Stage 8: pre-save invariant gate ──
      if (routed.primary) {
        const gate = checkSignalInvariants({
          asset_id: routed.primary.asset_id,
          asset_kind: routed.primary.kind,
          asset_symbol: routed.primary.symbol,
          direction:
            f.classification.sentiment === "negative" ? "short" : "long",
          tier,
          confidence: conviction,
          reasoning: f.classification.reasoning,
          expected_horizon: "auto",
          suggested_stop_pct: 5,
          suggested_target_pct: 12,
          asset_relevance:
            routed.primary.relevance === "subject"
              ? 1.0
              : routed.primary.relevance === "directly_affected"
                ? 0.8
                : 0.5,
          catalyst_subtype: subtype,
          promotional_score: promo.score,
          source_tier: sourceTier,
          expires_at: lifecycle.expires_at,
          corroboration_deadline: lifecycle.corroboration_deadline,
          event_chain_id: lifecycle.event_chain_id,
          is_digest: digest.is_digest,
          title_validation_ok: passes_ingestion,
          // Dimension 5 / 3 / 4 fields default to null on synthetic
          // adversarial fixtures (the gate skips those rules cleanly).
          base_rate: null,
          mechanism_length: null,
          counterfactual_strength: null,
        });
        // Gate must approve the (non-blocked) signals.
        // For fixtures whose `must_not` rules already trip earlier
        // (e.g. fire_on), the gate may still approve — we already
        // validated upstream behavior above.
        expect(
          gate.ok,
          `${f.id}: gate violations: ${gate.violations.map((v) => v.rule).join(", ")}`,
        ).toBe(true);
      }
    });
  }
});
