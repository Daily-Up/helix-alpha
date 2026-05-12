/**
 * Canonical type contracts for the news → signal pipeline.
 *
 * Each type sits at a specific stage. Consumers downstream MUST honor
 * these contracts; the pre-save invariant gate enforces them as a
 * last line of defense.
 *
 * Pipeline stages (in order):
 *   1. Ingestion       — RawNewsItem  → ValidatedNewsItem
 *   2. Classification  → Classification with extra subtype + promo + chain fields
 *   3. Asset routing   → AssetRouting with relevance scores
 *   4. Conviction      → ConvictionAxes (multi-axis weighted)
 *   5. Risk derivation → RiskProfile (subtype-aware)
 *   6. Conflict detect → ConflictReport
 *   7. Tier assignment → SignalTier with corroboration check
 *   8. Persistence     → invariant gate fires before INSERT
 */

// ─────────────────────────────────────────────────────────────────────────
// Stage 1: Ingestion
// ─────────────────────────────────────────────────────────────────────────

/** Reasons a raw news item can be rejected during ingestion. */
export type IngestionRejectReason =
  | "malformed_title" // HTML, doubled source name, mid-sentence ellipsis, >250 chars
  | "empty_after_sanitize" // sanitizer reduced everything to empty string
  | "duplicate_canonical" // matches existing duplicate_of pointer
  | "no_release_time"
  | "untrusted_origin";

export interface ValidatedNewsItem {
  id: string;
  release_time: number; // ms epoch UTC
  title: string; // sanitized, format-validated
  content: string | null; // sanitized HTML-stripped
  author: string | null;
  source_link: string | null;
  is_blue_verified: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 2: Classification
// ─────────────────────────────────────────────────────────────────────────

/**
 * Catalyst subtype — finer than event_type. Each subtype has a known
 * decay profile (how fast the price impact dissipates), which drives
 * lifecycle expiresAt in stage 8.
 *
 * Mapping from event_type → subtype is heuristic (see `inferCatalystSubtype`).
 */
export type CatalystSubtype =
  | "transient_operational" // exchange outage, AWS incident — hours
  | "whale_flow" // large on-chain transfer — 1-12h
  | "etf_flow_reaction" // daily ETF inflow/outflow data — 1-2d
  | "earnings_reaction" // Q1 print — 1-3d
  | "regulatory_statement" // SEC/CFTC speech — 3-7d
  | "regulatory_enforcement" // letters, subpoenas — 1-3d
  | "regulatory_action" // umbrella reg action: election outcome, nomination — corpus-keyed
  | "regulatory_etf_approval" // SEC approves spot ETF — primary institutional unlock
  | "regulatory_taxonomy_ruling" // legal classification (security vs commodity, etc.)
  | "legislative_progress" // Clarity Act markup — gates on next event
  | "macro_print" // CPI, FOMC, NFP — 3-5d
  | "macro_geopolitical" // tanker attacks, sanctions — multi-day
  | "fed_decision" // FOMC rate decision specifically — 5d
  | "geopolitical_escalation" // war/sanction onset — multi-day risk-off
  | "geopolitical_deescalation" // ceasefire/talks — risk-on
  | "exploit_disclosure" // hack confirmed — 1-4h then decay
  | "security_disclosure" // vuln found, no exploit — 6-24h
  | "defi_exploit" // DeFi-specific exploit (corpus-keyed) — 4h
  | "governance_vote" // DAO decision — decays at vote time
  | "treasury_action" // MSTR buys BTC — 1-3d
  | "corporate_treasury_buy" // corporate balance-sheet BTC accumulation
  | "partnership_announcement" // commercial integration — 24h
  | "fundraising_announcement" // VC round — 5d, capped if small
  | "listing_event" // exchange adds token — 12h
  | "tech_update" // mainnet, upgrade — 5d
  | "narrative_shift" // sector rotation, opinion piece — 3d, capped
  | "social_platform_action" // X bans, Discord seizures — 24h
  | "unlock_supply" // token unlock — 48h
  | "token_unlock" // corpus alias for unlock_supply — token-side scheduled unlocks
  | "airdrop_announcement" // claim window — 3d
  | "halving_event" // BTC halving — multi-month structural
  | "manipulation_fud" // attacks/FUD/rumor cycles — 1-2d
  | "semiconductor_earnings" // NVDA/AMD prints — 3d, AI-correlated
  | "big_tech_capex" // MSFT/META/GOOGL capex announcements — 5d
  | "ai_chip_export_policy" // chip export controls — 5d, AI sector
  | "other";

/** How relevant an asset is to a particular event. Drives the asset
 *  router (stage 3) and conflict detector (stage 6). */
export type AssetRelevanceLevel =
  | "subject" // 1.0 — the named subject of the catalyst
  | "directly_affected" // 0.8 — named entity, not subject (e.g. counterparty)
  | "basket_with_member" // 0.5 — a basket containing a verified subject
  | "incidentally_mentioned" // 0.3 — appears in title/body but not central
  | "basket_without_member"; // 0.0 — block: basket doesn't contain the subject

export const ASSET_RELEVANCE_SCORE: Record<AssetRelevanceLevel, number> = {
  subject: 1.0,
  directly_affected: 0.8,
  basket_with_member: 0.5,
  incidentally_mentioned: 0.3,
  basket_without_member: 0.0,
};

/** Conflict-detection threshold: only signals with relevance >= this
 *  for the same asset count as conflicts (vs. related-context). */
export const CONFLICT_RELEVANCE_THRESHOLD = 0.6;

/** Promotional/shill language score in [0,1]. Drives tier capping in stage 7. */
export interface PromotionalScore {
  score: number;
  reasons: string[]; // human-readable: "caps_lock", "rocket_emoji", etc.
}

/** Source tier: 1 = primary (Bloomberg/SEC/etc.), 2 = aggregator, 3 = anon. */
export type SourceTier = 1 | 2 | 3;

// ─────────────────────────────────────────────────────────────────────────
// Stage 3: Asset routing
// ─────────────────────────────────────────────────────────────────────────

export interface AssetCandidate {
  asset_id: string;
  symbol: string;
  kind: string;
  tradable: boolean;
  relevance: AssetRelevanceLevel;
  /** Reason the relevance level was assigned (audit trail). */
  reason: string;
}

export interface AssetRouting {
  primary: AssetCandidate | null;
  secondaries: AssetCandidate[];
  /** Assets that were considered and rejected. */
  rejected: Array<{ candidate: AssetCandidate; reason: string }>;
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 4: Conviction (already exists in signal-generator; surfaced here
//          so tests can construct it without round-tripping the DB)
// ─────────────────────────────────────────────────────────────────────────

export interface ConvictionAxesShape {
  classifier_confidence: number;
  tradability: number;
  severity: number;
  source_tier: number;
  polarity_clarity: number;
  event_type_weight: number;
  novelty: number;
  total: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 5: Risk derivation
// ─────────────────────────────────────────────────────────────────────────

export interface RiskProfileV2 {
  /** Vol-normalized: target as a multiple of the asset's 30d realized vol. */
  target_vol_multiple: number;
  /** Same for stop. */
  stop_vol_multiple: number;
  /** Concrete % once the asset's vol is plugged in. */
  target_pct: number;
  stop_pct: number;
  /** Time the catalyst remains tradable. */
  horizon: string; // e.g. "4h" / "3d"
  horizon_ms: number;
  /** Subtype that drove these numbers. */
  subtype: CatalystSubtype;
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 6: Conflict detection
// ─────────────────────────────────────────────────────────────────────────

export type ConflictKind =
  | "no_overlap"
  | "related_context" // both signals touch asset but at least one is incidental
  | "conflict"; // both relevance >= 0.6 AND opposite directions

export interface ConflictReport {
  kind: ConflictKind;
  reason: string;
  /** Net-bias placeholder (could be filled later). */
  net_long_conviction: number;
  net_short_conviction: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 8: Lifecycle / persistence
// ─────────────────────────────────────────────────────────────────────────

export type DismissReason =
  | "stale_unexecuted" // past expiresAt
  | "uncorroborated" // single source past corroboration deadline
  | "superseded" // by stronger signal
  | "user_dismissed"
  | "story_dedup" // collapsed by story-cluster dedup
  | "invariant_violation"; // failed pre-save gate

/** Lifecycle metadata attached to every signal at generation. */
export interface SignalLifecycle {
  /** Auto-dismiss after this timestamp. Derived from subtype. */
  expires_at: number;
  /** If single-source: dismiss if no second source by this time. */
  corroboration_deadline: number | null;
  /** Hash linking signals from the same evolving narrative. */
  event_chain_id: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 8: Pre-save invariant gate
// ─────────────────────────────────────────────────────────────────────────

export interface InvariantViolation {
  rule: string;
  message: string;
  severity: "block" | "warn";
}

export interface InvariantCheckResult {
  ok: boolean;
  violations: InvariantViolation[];
}
