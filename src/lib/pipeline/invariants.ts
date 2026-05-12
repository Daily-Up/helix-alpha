/**
 * Stage 8 — Pre-save invariant gate.
 *
 * The last line of defense. Every signal that's about to hit
 * `Signals.insertSignal()` runs through `checkSignalInvariants` first.
 * If ANY rule fails (severity=block), the gate refuses the insert and
 * logs the rule that fired.
 *
 * This is INSURANCE, not the primary fix. The right place to fix each
 * bug class is upstream:
 *   - title validation: stage 1 (ingestion)
 *   - digest detection: stage 2 (classification)
 *   - asset relevance: stage 3 (asset routing)
 *   - subtype + risk: stage 5 (risk derivation)
 *   - lifecycle: stage 8 (this stage, pre-insert)
 *
 * But because each upstream fix is in its own module, a future change
 * could weaken one of them and silently regress. The invariant gate
 * catches those regressions because it checks the FINAL signal shape
 * regardless of how it got that way.
 *
 * Add a new rule here whenever you discover a bug class that escaped
 * upstream checks.
 *
 * Companion tests: tests/invariants.test.ts
 */

import {
  CONFLICT_RELEVANCE_THRESHOLD,
  type CatalystSubtype,
  type InvariantCheckResult,
  type InvariantViolation,
  type SourceTier,
} from "./types";
import {
  type BaseRate,
  baseRateTargetCeiling,
  exceedsBaseRateTarget,
} from "./base-rates";

/**
 * Shape passed to the gate. The signal generator builds this object
 * from the partial NewSignal + pipeline metadata it computed.
 */
export interface PreSaveSignal {
  asset_id: string;
  asset_kind: string;
  asset_symbol: string;
  direction: "long" | "short";
  tier: "auto" | "review" | "info";
  confidence: number;
  reasoning: string;
  expected_horizon: string;
  suggested_stop_pct: number;
  suggested_target_pct: number;
  // Pipeline metadata (must be present for invariants to pass)
  asset_relevance: number; // [0..1]
  catalyst_subtype: CatalystSubtype | undefined;
  promotional_score: number;
  source_tier: SourceTier;
  expires_at: number;
  corroboration_deadline: number | null;
  event_chain_id: string | null;
  is_digest: boolean;
  title_validation_ok: boolean;
  // ── Dimension 5 (base rates) — null when no entry exists for the
  //    (subtype, asset_class) pair; gate falls through cleanly. ──
  base_rate: BaseRate | null;
  // ── Dimension 3/4 (reasoning-enriched classification) ──
  /** 1=direct, 4=speculative; cap enforced by invariant I-27. */
  mechanism_length: 1 | 2 | 3 | 4 | null;
  /** weak/moderate/strong; cap enforced by invariant I-28. */
  counterfactual_strength: "weak" | "moderate" | "strong" | null;
  // ── Dimension 1 (semantic freshness) ──
  /** Set when this signal's source article was flagged as a duplicate
   *  of a prior event's coverage. Gate refuses these so we don't
   *  persist two signals on what is structurally the same news. */
  is_semantic_duplicate?: boolean;
  /** Maximum cosine similarity to recent classifications (audit). */
  freshness_similarity?: number | null;
  // ── Dimension 2 (price-already-moved) ──
  /** Fraction of the expected move already realized in the asset.
   *  > 0.6 → cap to INFO; > 1.0 → drop; < -0.3 → drop (market disagrees). */
  realized_fraction?: number | null;
}

export function checkSignalInvariants(
  s: PreSaveSignal,
  now = Date.now(),
): InvariantCheckResult {
  const violations: InvariantViolation[] = [];

  // ── Bug class 6: digest must not produce signals ──
  if (s.is_digest) {
    violations.push({
      rule: "digest_source",
      message: "Signal source article was flagged as digest/roundup",
      severity: "block",
    });
  }

  // ── Bug class 7: title validation must have passed at ingestion ──
  if (!s.title_validation_ok) {
    violations.push({
      rule: "ingestion_title_invalid",
      message: "Source title failed ingestion validation",
      severity: "block",
    });
  }

  // ── Bug class 1: relevance must clear primary threshold ──
  if (s.asset_relevance === 0) {
    violations.push({
      rule: "asset_basket_without_member",
      message: `Asset ${s.asset_id} (${s.asset_kind}) is a basket whose constituents don't include the named subject`,
      severity: "block",
    });
  } else if (s.asset_relevance < 0.5) {
    violations.push({
      rule: "primary_below_relevance",
      message: `Asset relevance ${s.asset_relevance.toFixed(2)} < 0.5 — not a credible primary subject`,
      severity: "block",
    });
  }

  // ── Bug class 8: AUTO tier must have promotional cap applied ──
  if (
    s.tier === "auto" &&
    s.promotional_score >= 0.5 &&
    s.source_tier > 1
  ) {
    violations.push({
      rule: "auto_promotional_uncapped",
      message: `AUTO tier on tier-${s.source_tier} source with promo score ${s.promotional_score.toFixed(2)} — should have been capped to INFO`,
      severity: "block",
    });
  }

  // ── Bug class 3: lifecycle must be in the future ──
  if (s.expires_at <= now) {
    violations.push({
      rule: "expires_at_in_past",
      message: `expires_at (${s.expires_at}) is not in the future — signal would be born expired`,
      severity: "block",
    });
  }

  // ── Required metadata presence ──
  if (!s.catalyst_subtype) {
    violations.push({
      rule: "missing_subtype",
      message: "catalyst_subtype is required for risk derivation + lifecycle",
      severity: "block",
    });
  }

  // ── Sanity: confidence in [0, 1] ──
  if (s.confidence < 0 || s.confidence > 1 || !Number.isFinite(s.confidence)) {
    violations.push({
      rule: "confidence_out_of_range",
      message: `confidence=${s.confidence} not in [0,1]`,
      severity: "block",
    });
  }

  // ── Sanity: stop/target positive ──
  if (s.suggested_stop_pct <= 0) {
    violations.push({
      rule: "stop_pct_non_positive",
      message: `suggested_stop_pct=${s.suggested_stop_pct} must be > 0`,
      severity: "block",
    });
  }
  if (s.suggested_target_pct <= 0) {
    violations.push({
      rule: "target_pct_non_positive",
      message: `suggested_target_pct=${s.suggested_target_pct} must be > 0`,
      severity: "block",
    });
  }

  // ── Sanity: tier matches catalyst availability ──
  // (kept lightweight — heavy-lift tier rules are upstream)

  // ── Bug class F: earnings_reaction must target a stock/treasury ──
  // Earnings = quarterly print of a public company. Tokens (meme,
  // governance, utility) don't have earnings, so a signal where
  // catalyst_subtype='earnings_reaction' fired on a token is a routing
  // error. Real example: an "earnings_reaction" SHORT on TRUMP (meme
  // token) — TRUMP doesn't have a Q1 print. Block it; the signal
  // generator should have selected the listed entity (TMTG / DJT
  // stock / treasury) as primary, not the meme namesake.
  if (
    s.catalyst_subtype === "earnings_reaction" &&
    s.asset_kind !== "stock" &&
    s.asset_kind !== "treasury"
  ) {
    violations.push({
      rule: "earnings_reaction_on_non_corporate",
      message: `Signal subtype 'earnings_reaction' fired on asset_kind='${s.asset_kind}' (${s.asset_id}). Earnings events apply to public companies (kind=stock or kind=treasury), not tokens. Routing error upstream.`,
      severity: "block",
    });
  }

  // ── Dimension 1 (I-25): semantic_duplicate ──
  // The freshness gate at ingestion catches most duplicates; this is the
  // pre-save fallback for cases where the upstream check was skipped
  // (e.g. legacy events without embeddings) or the threshold was edge-of-band
  // and a duplicate slipped through to signal generation.
  if (s.is_semantic_duplicate === true) {
    violations.push({
      rule: "semantic_duplicate",
      message: `signal source article is semantically duplicate of recent classification (sim ${s.freshness_similarity?.toFixed(2) ?? "?"})`,
      severity: "block",
    });
  }

  // ── Dimension 2 (I-26): price-already-moved ──
  // realized_fraction = (current - catalyst_time_price) / expected_move,
  // signed by predicted direction.
  //   > 1.0 → move exhausted, drop (`move_exhausted`)
  //   > 0.6 → mostly priced-in, downgraded upstream; gate doesn't refuse
  //           because UPSTREAM is responsible for the cap, BUT if the
  //           signal still came in at AUTO/REVIEW with realized > 0.6,
  //           the upstream stage forgot the rule — refuse.
  //   < -0.3 → market disagrees, drop (`market_disagrees`)
  if (s.realized_fraction != null) {
    if (s.realized_fraction > 1.0) {
      violations.push({
        rule: "move_exhausted",
        message: `realized_fraction=${s.realized_fraction.toFixed(2)} exceeds expected move; alpha already played out`,
        severity: "block",
      });
    } else if (s.realized_fraction < -0.3) {
      violations.push({
        rule: "market_disagrees",
        message: `realized_fraction=${s.realized_fraction.toFixed(2)} — market moved against the predicted direction`,
        severity: "block",
      });
    } else if (s.realized_fraction > 0.6 && s.tier !== "info") {
      violations.push({
        rule: "move_largely_realized",
        message: `realized_fraction=${s.realized_fraction.toFixed(2)} > 0.6 but tier=${s.tier} (should be INFO upstream)`,
        severity: "block",
      });
    }
  }

  // ── Dimension 5 (I-29): target_exceeds_base_rate ──
  // If a calibrated (subtype, asset_class) base rate exists and the
  // signal's target_pct exceeds 2× (mean + stdev), the upstream stage
  // produced a target the historical band can't justify. The gate
  // refuses; the right fix is to consult base_rates.json upstream, not
  // to soften this rule.
  if (s.base_rate && exceedsBaseRateTarget(s.suggested_target_pct, s.base_rate)) {
    const ceiling = baseRateTargetCeiling(s.base_rate);
    violations.push({
      rule: "target_exceeds_base_rate",
      message: `target ${s.suggested_target_pct.toFixed(1)}% exceeds 2× base-rate band (mean=${s.base_rate.mean_move_pct}%, stdev=${s.base_rate.stdev_move_pct}%, ceiling=${ceiling.toFixed(1)}%)`,
      severity: "block",
    });
  }

  // ── Dimension 3/4 (I-27): mechanism length conviction cap ──
  // mechanism_length 1 → no cap; 2 → 0.85; 3 → 0.70; 4 → 0.55.
  // The cap is a pure function of (mechanism_length, conviction); the
  // gate refuses signals where the LLM (or generator) failed to
  // self-apply it. mechanism_length=null is a valid skip — older
  // classifications didn't have this field.
  if (s.mechanism_length != null) {
    const cap =
      s.mechanism_length === 2
        ? 0.85
        : s.mechanism_length === 3
          ? 0.70
          : s.mechanism_length === 4
            ? 0.55
            : 1.0;
    if (s.confidence > cap + 1e-6) {
      violations.push({
        rule: "mechanism_conviction_excess",
        message: `confidence ${s.confidence.toFixed(2)} > cap ${cap.toFixed(2)} for mechanism_length=${s.mechanism_length}`,
        severity: "block",
      });
    }
  }

  // ── Dimension 3 (I-28): counterfactual strength conviction cap ──
  // weak → no cap; moderate → 0.80; strong → 0.60.
  if (s.counterfactual_strength != null) {
    const cap =
      s.counterfactual_strength === "strong"
        ? 0.60
        : s.counterfactual_strength === "moderate"
          ? 0.80
          : 1.0;
    if (s.confidence > cap + 1e-6) {
      violations.push({
        rule: "counterfactual_conviction_excess",
        message: `confidence ${s.confidence.toFixed(2)} > cap ${cap.toFixed(2)} for counterfactual=${s.counterfactual_strength}`,
        severity: "block",
      });
    }
  }

  // Touch CONFLICT_RELEVANCE_THRESHOLD so downstream tooling knows it
  // exists; not an invariant per se.
  void CONFLICT_RELEVANCE_THRESHOLD;

  return {
    ok: violations.filter((v) => v.severity === "block").length === 0,
    violations,
  };
}
