/**
 * Repository — `classifications`.
 *
 * Stores the Claude-generated taxonomy for each event so we can group,
 * filter, and pattern-match without re-running the LLM.
 *
 * Wave 2: async (libSQL/Turso).
 */

import { all, get, run } from "../client";

/** Canonical event types Claude classifies into. Keep this stable. */
export const EventTypes = [
  "exploit",
  "regulatory",
  "etf_flow",
  "partnership",
  "listing",
  "social_platform",
  "unlock",
  "airdrop",
  "earnings",
  "macro",
  "treasury",
  "governance",
  "tech_update",
  "security",
  "narrative",
  "fundraising",
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
  confidence: number;
  actionable: boolean | null;
  event_recency: EventRecency | null;
  affected_asset_ids: string[];
  reasoning: string;
  model: string;
  prompt_version: string;
  classified_at: number;
  embedding?: number[] | null;
  coverage_continuation_of?: string | null;
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
export async function upsertClassification(
  c: Omit<Classification, "classified_at">,
): Promise<void> {
  await run(
    `INSERT INTO classifications (
       event_id, event_type, sentiment, severity, confidence,
       actionable, event_recency,
       affected_asset_ids, reasoning, model, prompt_version,
       embedding, coverage_continuation_of,
       mechanism_length, mechanism_reasoning,
       counterfactual_strength, counterfactual_reasoning
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    [
      c.event_id,
      c.event_type,
      c.sentiment,
      c.severity,
      c.confidence,
      c.actionable === null || c.actionable === undefined
        ? null
        : c.actionable
          ? 1
          : 0,
      c.event_recency ?? null,
      JSON.stringify(c.affected_asset_ids),
      c.reasoning,
      c.model,
      c.prompt_version,
      c.embedding ? JSON.stringify(c.embedding) : null,
      c.coverage_continuation_of ?? null,
      c.mechanism_length ?? null,
      c.mechanism_reasoning ?? null,
      c.counterfactual_strength ?? null,
      c.counterfactual_reasoning ?? null,
    ],
  );
}

/**
 * Get the embeddings of classifications from the last `sinceMs` ms.
 */
export async function listRecentEmbeddings(
  sinceMs: number,
): Promise<Array<{ event_id: string; embedding: number[] }>> {
  const rows = await all<{ event_id: string; embedding: string }>(
    `SELECT c.event_id, c.embedding
     FROM classifications c
     JOIN news_events n ON n.id = c.event_id
     WHERE c.embedding IS NOT NULL
       AND n.release_time >= ?
     ORDER BY c.classified_at DESC
     LIMIT 500`,
    [sinceMs],
  );
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

export async function getClassification(
  eventId: string,
): Promise<Classification | undefined> {
  const row = await get<ClassificationRow>(
    "SELECT * FROM classifications WHERE event_id = ?",
    [eventId],
  );
  return row ? rowToClassification(row) : undefined;
}

/** Counts grouped by event_type for dashboard widgets. */
export async function countByEventType(opts?: {
  sinceMs?: number;
}): Promise<Array<{ event_type: EventType; n: number }>> {
  const since = opts?.sinceMs ?? 0;
  return all<{ event_type: EventType; n: number }>(
    `SELECT c.event_type AS event_type, COUNT(*) AS n
     FROM classifications c
     JOIN news_events e ON e.id = c.event_id
     WHERE e.release_time >= ?
     GROUP BY c.event_type
     ORDER BY n DESC`,
    [since],
  );
}
