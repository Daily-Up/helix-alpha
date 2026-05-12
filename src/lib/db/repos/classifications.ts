/**
 * Repository — `classifications`.
 *
 * Stores the Claude-generated taxonomy for each event so we can group,
 * filter, and pattern-match without re-running the LLM.
 */

import { db } from "../client";

/** Canonical event types Claude classifies into. Keep this stable. */
export const EventTypes = [
  "exploit",         // protocol hack, drained funds
  "regulatory",      // SEC/CFTC/government action
  "etf_flow",        // unusual ETF inflow/outflow
  "partnership",     // partnership, integration
  "listing",         // exchange listing or delisting
  "social_platform", // X/Twitter API ban, social-media platform action
  "unlock",          // token unlock / vesting cliff
  "airdrop",         // airdrop announcement
  "earnings",        // public-company earnings (COIN, MSTR, etc.)
  "macro",           // CPI, FOMC, inflation, employment
  "treasury",        // corporate BTC purchase / sale
  "governance",      // DAO vote, parameter change
  "tech_update",     // protocol upgrade, hard fork
  "security",        // bug discovered / patched (no exploit yet)
  "narrative",       // narrative shift, sector rotation news
  "fundraising",     // VC raise, token sale
  "other",
] as const;
export type EventType = (typeof EventTypes)[number];

export const Sentiments = ["positive", "negative", "neutral"] as const;
export type Sentiment = (typeof Sentiments)[number];

export const Severities = ["high", "medium", "low"] as const;
export type Severity = (typeof Severities)[number];

export const EventRecencies = ["live", "today", "this_week", "older"] as const;
export type EventRecency = (typeof EventRecencies)[number];

export interface Classification {
  event_id: string;
  event_type: EventType;
  sentiment: Sentiment;
  severity: Severity;
  confidence: number; // 0..1
  /** Whether a trader could profitably act on this RIGHT NOW. */
  actionable: boolean | null;
  /** When the underlying event happened (vs publish time). */
  event_recency: EventRecency | null;
  affected_asset_ids: string[];
  reasoning: string;
  model: string;
  prompt_version: string;
  classified_at: number;
  // ── Dimension 1 (semantic freshness) ──
  /** Embedding of (title + primaryActor + affectedEntities). NULL on
   *  pre-D1 rows. Stored as JSON-serialized number[] for query simplicity. */
  embedding?: number[] | null;
  /** Set when freshness gate flagged this article as a continuation
   *  (0.42 ≤ sim < 0.55) of a prior event. NULL on novel events. */
  coverage_continuation_of?: string | null;
  // ── Dimensions 3/4 (reasoning-enriched classification) ──
  mechanism_length?: 1 | 2 | 3 | 4 | null;
  mechanism_reasoning?: string | null;
  counterfactual_strength?: "weak" | "moderate" | "strong" | null;
  counterfactual_reasoning?: string | null;
}

interface ClassificationRow {
  event_id: string;
  event_type: EventType;
  sentiment: Sentiment;
  severity: Severity;
  confidence: number;
  actionable: number | null;
  event_recency: EventRecency | null;
  affected_asset_ids: string;
  reasoning: string;
  model: string;
  prompt_version: string;
  classified_at: number;
}

function rowToClassification(row: ClassificationRow): Classification {
  return {
    ...row,
    actionable:
      row.actionable === null
        ? null
        : row.actionable === 1 || (row.actionable as unknown) === true,
    affected_asset_ids: JSON.parse(row.affected_asset_ids),
  };
}

/** Upsert a classification (re-classifying an event overwrites). */
export function upsertClassification(
  c: Omit<Classification, "classified_at">,
): void {
  db()
    .prepare(
      `INSERT INTO classifications (
         event_id, event_type, sentiment, severity, confidence,
         actionable, event_recency,
         affected_asset_ids, reasoning, model, prompt_version,
         embedding, coverage_continuation_of,
         mechanism_length, mechanism_reasoning,
         counterfactual_strength, counterfactual_reasoning
       ) VALUES (
         @event_id, @event_type, @sentiment, @severity, @confidence,
         @actionable, @event_recency,
         @affected_asset_ids, @reasoning, @model, @prompt_version,
         @embedding, @coverage_continuation_of,
         @mechanism_length, @mechanism_reasoning,
         @counterfactual_strength, @counterfactual_reasoning
       )
       ON CONFLICT(event_id) DO UPDATE SET
         event_type               = excluded.event_type,
         sentiment                = excluded.sentiment,
         severity                 = excluded.severity,
         confidence               = excluded.confidence,
         actionable               = excluded.actionable,
         event_recency            = excluded.event_recency,
         affected_asset_ids       = excluded.affected_asset_ids,
         reasoning                = excluded.reasoning,
         model                    = excluded.model,
         prompt_version           = excluded.prompt_version,
         embedding                = COALESCE(excluded.embedding, classifications.embedding),
         coverage_continuation_of = COALESCE(excluded.coverage_continuation_of, classifications.coverage_continuation_of),
         mechanism_length         = COALESCE(excluded.mechanism_length, classifications.mechanism_length),
         mechanism_reasoning      = COALESCE(excluded.mechanism_reasoning, classifications.mechanism_reasoning),
         counterfactual_strength  = COALESCE(excluded.counterfactual_strength, classifications.counterfactual_strength),
         counterfactual_reasoning = COALESCE(excluded.counterfactual_reasoning, classifications.counterfactual_reasoning),
         classified_at            = unixepoch() * 1000`,
    )
    .run({
      ...c,
      actionable:
        c.actionable === null || c.actionable === undefined
          ? null
          : c.actionable
            ? 1
            : 0,
      event_recency: c.event_recency ?? null,
      affected_asset_ids: JSON.stringify(c.affected_asset_ids),
      embedding: c.embedding ? JSON.stringify(c.embedding) : null,
      coverage_continuation_of: c.coverage_continuation_of ?? null,
      mechanism_length: c.mechanism_length ?? null,
      mechanism_reasoning: c.mechanism_reasoning ?? null,
      counterfactual_strength: c.counterfactual_strength ?? null,
      counterfactual_reasoning: c.counterfactual_reasoning ?? null,
    });
}

/**
 * Get the embeddings of classifications from the last `sinceMs` ms.
 * Used by the freshness gate to compare a new article against recent
 * coverage. Skips rows with no embedding (legacy / model not yet wired).
 */
export function listRecentEmbeddings(
  sinceMs: number,
): Array<{ event_id: string; embedding: number[] }> {
  const rows = db()
    .prepare<[number], { event_id: string; embedding: string }>(
      `SELECT c.event_id, c.embedding
       FROM classifications c
       JOIN news_events n ON n.id = c.event_id
       WHERE c.embedding IS NOT NULL
         AND n.release_time >= ?
       ORDER BY c.classified_at DESC
       LIMIT 500`,
    )
    .all(sinceMs);
  const out: Array<{ event_id: string; embedding: number[] }> = [];
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.embedding) as number[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        out.push({ event_id: r.event_id, embedding: parsed });
      }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export function getClassification(eventId: string): Classification | undefined {
  const row = db()
    .prepare<[string], ClassificationRow>(
      "SELECT * FROM classifications WHERE event_id = ?",
    )
    .get(eventId);
  return row ? rowToClassification(row) : undefined;
}

/** Counts grouped by event_type for dashboard widgets. */
export function countByEventType(opts?: {
  sinceMs?: number;
}): Array<{ event_type: EventType; n: number }> {
  const since = opts?.sinceMs ?? 0;
  return db()
    .prepare<[number], { event_type: EventType; n: number }>(
      `SELECT c.event_type AS event_type, COUNT(*) AS n
       FROM classifications c
       JOIN news_events e ON e.id = c.event_id
       WHERE e.release_time >= ?
       GROUP BY c.event_type
       ORDER BY n DESC`,
    )
    .all(since);
}
