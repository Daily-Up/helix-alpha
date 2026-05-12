/**
 * Calibration corpus loader + validator.
 *
 * The corpus at `data/calibration-corpus.json` is the source of truth for
 * empirical base rates. The system rejects LLM-estimated base rates per
 * invariant I-44; rates must derive from this corpus.
 *
 * Loader responsibilities:
 *   - load JSON from disk (server-only — never bundled into client)
 *   - validate schema + per-event integrity (Phase A invariants)
 *   - expose helpers: byAsset, bySubtype, byAssetClass
 *
 * Companion tests: tests/calibration-corpus.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type CorpusConfidence = "high" | "medium" | "recent";
export type CorpusDirection = "long" | "short";

export interface CorpusEvent {
  id: string;
  date: string; // ISO-8601 YYYY-MM-DD
  asset: string;
  asset_class: string;
  catalyst_subtype: string;
  direction: CorpusDirection;
  realized_pct_move: number;
  duration_to_peak_days: number;
  duration_of_impact_days: number;
  source_event_text: string;
  confidence: CorpusConfidence;
  notes: string;
}

export interface CalibrationCorpus {
  schema_version: string;
  generated_at: string;
  description: string;
  confidence_tiers: Record<string, string>;
  taxonomy_extensions: string[];
  events: CorpusEvent[];
}

export interface ValidationIssue {
  severity: "error" | "warning";
  event_id: string | null;
  rule: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  total_events: number;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  subtype_counts: Record<string, number>;
  asset_class_counts: Record<string, number>;
  confidence_counts: Record<string, number>;
}

const CORPUS_PATH = join(process.cwd(), "data", "calibration-corpus.json");

let _cached: CalibrationCorpus | null = null;

/** Load (and cache) the corpus from disk. Server-only. */
export function loadCorpus(): CalibrationCorpus {
  if (_cached) return _cached;
  const raw = readFileSync(CORPUS_PATH, "utf-8");
  const parsed = JSON.parse(raw) as CalibrationCorpus;
  _cached = parsed;
  return parsed;
}

/** Reset the loader cache. Test-only. */
export function _resetCorpusCache(): void {
  _cached = null;
}

/**
 * Validate a corpus payload against the Phase A integrity rules.
 *
 * Rules enforced:
 *   R1  schema_version present and non-empty
 *   R2  generated_at parseable as Date
 *   R3  taxonomy_extensions is a non-empty array of strings
 *   R4  events is a non-empty array
 *   R5  each event has all required fields
 *   R6  each event id is unique
 *   R7  each event date matches YYYY-MM-DD and parses
 *   R8  direction ∈ {long, short}
 *   R9  confidence ∈ {high, medium, recent}
 *   R10 realized_pct_move is a finite number
 *   R11 duration_* values are non-negative integers
 *   R12 source_event_text non-empty
 *   R13 every catalyst_subtype is either in taxonomy_extensions OR a
 *       known existing CatalystSubtype (warning, not error — keeps the
 *       corpus tractable when the runtime taxonomy evolves)
 */
export function validateCorpus(
  corpus: CalibrationCorpus,
  knownSubtypes: ReadonlySet<string>,
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const seenIds = new Set<string>();
  const subtypeCounts: Record<string, number> = {};
  const assetClassCounts: Record<string, number> = {};
  const confidenceCounts: Record<string, number> = {};

  // R1
  if (!corpus.schema_version || typeof corpus.schema_version !== "string") {
    errors.push({
      severity: "error",
      event_id: null,
      rule: "R1_schema_version",
      message: "schema_version missing or not a string",
    });
  }

  // R2
  if (!corpus.generated_at || isNaN(Date.parse(corpus.generated_at))) {
    errors.push({
      severity: "error",
      event_id: null,
      rule: "R2_generated_at",
      message: `generated_at unparseable: ${corpus.generated_at}`,
    });
  }

  // R3
  if (
    !Array.isArray(corpus.taxonomy_extensions) ||
    corpus.taxonomy_extensions.length === 0
  ) {
    errors.push({
      severity: "error",
      event_id: null,
      rule: "R3_taxonomy_extensions",
      message: "taxonomy_extensions must be a non-empty array",
    });
  }

  // R4
  if (!Array.isArray(corpus.events) || corpus.events.length === 0) {
    errors.push({
      severity: "error",
      event_id: null,
      rule: "R4_events",
      message: "events must be a non-empty array",
    });
    return summary(errors, warnings, 0, subtypeCounts, assetClassCounts, confidenceCounts);
  }

  const required: Array<keyof CorpusEvent> = [
    "id",
    "date",
    "asset",
    "asset_class",
    "catalyst_subtype",
    "direction",
    "realized_pct_move",
    "duration_to_peak_days",
    "duration_of_impact_days",
    "source_event_text",
    "confidence",
    "notes",
  ];

  const taxonomyExtensionsSet = new Set(corpus.taxonomy_extensions);

  for (const e of corpus.events) {
    // R5
    for (const f of required) {
      if ((e as unknown as Record<string, unknown>)[f] === undefined) {
        errors.push({
          severity: "error",
          event_id: e.id ?? null,
          rule: "R5_required_field",
          message: `missing required field: ${String(f)}`,
        });
      }
    }
    if (!e.id) continue;

    // R6
    if (seenIds.has(e.id)) {
      errors.push({
        severity: "error",
        event_id: e.id,
        rule: "R6_unique_id",
        message: `duplicate event id: ${e.id}`,
      });
    }
    seenIds.add(e.id);

    // R7
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date) || isNaN(Date.parse(e.date))) {
      errors.push({
        severity: "error",
        event_id: e.id,
        rule: "R7_date_format",
        message: `bad date: ${e.date}`,
      });
    }

    // R8
    if (e.direction !== "long" && e.direction !== "short") {
      errors.push({
        severity: "error",
        event_id: e.id,
        rule: "R8_direction",
        message: `bad direction: ${e.direction}`,
      });
    }

    // R9
    if (!["high", "medium", "recent"].includes(e.confidence)) {
      errors.push({
        severity: "error",
        event_id: e.id,
        rule: "R9_confidence",
        message: `bad confidence: ${e.confidence}`,
      });
    }

    // R10
    if (typeof e.realized_pct_move !== "number" || !Number.isFinite(e.realized_pct_move)) {
      errors.push({
        severity: "error",
        event_id: e.id,
        rule: "R10_realized_pct_move",
        message: `realized_pct_move not a finite number`,
      });
    }

    // R11
    if (
      typeof e.duration_to_peak_days !== "number" ||
      e.duration_to_peak_days < 0 ||
      typeof e.duration_of_impact_days !== "number" ||
      e.duration_of_impact_days < 0
    ) {
      errors.push({
        severity: "error",
        event_id: e.id,
        rule: "R11_duration_nonneg",
        message: `duration_* values must be non-negative numbers`,
      });
    }

    // R12
    if (!e.source_event_text || !e.source_event_text.trim()) {
      errors.push({
        severity: "error",
        event_id: e.id,
        rule: "R12_source_event_text",
        message: `source_event_text empty`,
      });
    }

    // R13 — warning only; corpus may use legacy subtypes that we keep
    if (
      !taxonomyExtensionsSet.has(e.catalyst_subtype) &&
      !knownSubtypes.has(e.catalyst_subtype)
    ) {
      warnings.push({
        severity: "warning",
        event_id: e.id,
        rule: "R13_subtype_known",
        message: `subtype not in taxonomy_extensions nor known: ${e.catalyst_subtype}`,
      });
    }

    subtypeCounts[e.catalyst_subtype] = (subtypeCounts[e.catalyst_subtype] ?? 0) + 1;
    assetClassCounts[e.asset_class] = (assetClassCounts[e.asset_class] ?? 0) + 1;
    confidenceCounts[e.confidence] = (confidenceCounts[e.confidence] ?? 0) + 1;
  }

  return summary(
    errors,
    warnings,
    corpus.events.length,
    subtypeCounts,
    assetClassCounts,
    confidenceCounts,
  );
}

function summary(
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  total: number,
  subtypeCounts: Record<string, number>,
  assetClassCounts: Record<string, number>,
  confidenceCounts: Record<string, number>,
): ValidationResult {
  return {
    ok: errors.length === 0,
    total_events: total,
    errors,
    warnings,
    subtype_counts: subtypeCounts,
    asset_class_counts: assetClassCounts,
    confidence_counts: confidenceCounts,
  };
}

/** All catalyst_subtype values used in the runtime CatalystSubtype union. */
export const KNOWN_SUBTYPES: ReadonlySet<string> = new Set<string>([
  "transient_operational",
  "whale_flow",
  "etf_flow_reaction",
  "earnings_reaction",
  "regulatory_statement",
  "regulatory_enforcement",
  "regulatory_action",
  "regulatory_etf_approval",
  "regulatory_taxonomy_ruling",
  "legislative_progress",
  "macro_print",
  "macro_geopolitical",
  "fed_decision",
  "geopolitical_escalation",
  "geopolitical_deescalation",
  "exploit_disclosure",
  "security_disclosure",
  "defi_exploit",
  "governance_vote",
  "treasury_action",
  "corporate_treasury_buy",
  "partnership_announcement",
  "fundraising_announcement",
  "listing_event",
  "tech_update",
  "narrative_shift",
  "social_platform_action",
  "unlock_supply",
  "token_unlock",
  "airdrop_announcement",
  "halving_event",
  "manipulation_fud",
  "semiconductor_earnings",
  "big_tech_capex",
  "ai_chip_export_policy",
  "other",
]);

/** All asset_class values our runtime understands. */
export const KNOWN_ASSET_CLASSES: ReadonlySet<string> = new Set<string>([
  "large_cap_crypto",
  "mid_cap_crypto",
  "small_cap_crypto",
  "crypto_adjacent_equity",
  "crypto_proxy",
  "broad_equity",
  "ai_semiconductor",
  "big_tech",
  "commodity",
  "index",
]);
