/**
 * News classifier — turns a raw event into a typed Classification.
 *
 * Wraps Anthropic's tool use so the output is schema-validated. Records
 * each result in the `classifications` table; designed to be re-runnable
 * (idempotent) so we can re-classify with a newer prompt version later.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  Classifications,
  Events,
  EventTypes,
  Sentiments,
  Severities,
  type EventType,
  type EventRecency,
  type Sentiment,
  type Severity,
} from "@/lib/db";
import { EventRecencies } from "@/lib/db/repos/classifications";
import type { StoredEvent } from "@/lib/db/repos/events";
import { DEFAULT_UNIVERSE, type Asset } from "@/lib/universe";
import { anthropic, getModel } from "./client";
import {
  CLASSIFY_PROMPT_VERSION,
  classifySystemPrompt,
  classifyTool,
  classifyUserMessage,
} from "./prompts/classify";

const ToolInputSchema = z.object({
  event_type: z.enum(EventTypes as unknown as [EventType, ...EventType[]]),
  sentiment: z.enum(Sentiments as unknown as [Sentiment, ...Sentiment[]]),
  severity: z.enum(Severities as unknown as [Severity, ...Severity[]]),
  confidence: z.number().min(0).max(1),
  actionable: z.boolean(),
  event_recency: z.enum(
    EventRecencies as unknown as [EventRecency, ...EventRecency[]],
  ),
  affected_asset_ids: z.array(z.string()),
  reasoning: z.string().min(1),
  // v6 (Dimension 3) — optional on the wire so v5 callers don't break;
  // when present, persisted onto the classification row and used by the
  // pre-save gate to enforce conviction caps (Dimension 4).
  mechanism_length: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  mechanism_reasoning: z.string().optional(),
  counterfactual_strength: z.enum(["weak", "moderate", "strong"]).optional(),
  counterfactual_reasoning: z.string().optional(),
});

export interface ClassificationResult {
  event_id: string;
  event_type: EventType;
  sentiment: Sentiment;
  severity: Severity;
  confidence: number;
  actionable: boolean;
  event_recency: EventRecency;
  affected_asset_ids: string[];
  reasoning: string;
  // v6 reasoning fields (D3) — undefined when the model didn't supply them.
  mechanism_length?: 1 | 2 | 3 | 4;
  mechanism_reasoning?: string;
  counterfactual_strength?: "weak" | "moderate" | "strong";
  counterfactual_reasoning?: string;
  /** Number of input/output tokens billed. */
  tokens: { input: number; output: number; cached: number };
  /** Latency end-to-end in ms. */
  latency_ms: number;
}

/**
 * Classify ONE event by calling Claude with the classify_event tool.
 *
 * Persists the result via Classifications.upsertClassification.
 * Returns the typed result + token usage for cost tracking.
 */
export async function classifyEvent(
  event: StoredEvent,
  options?: {
    universe?: Asset[];
    persist?: boolean;
    /** D1: pre-computed embedding for semantic freshness, persisted alongside. */
    embedding?: number[];
    /** D1: prior event id when this article is a continuation (0.42 ≤ sim < 0.55). */
    coverageContinuationOf?: string | null;
  },
): Promise<ClassificationResult> {
  const universe = options?.universe ?? DEFAULT_UNIVERSE;
  const persist = options?.persist ?? true;
  const model = getModel();

  const start = Date.now();
  const response = await anthropic().messages.create({
    model,
    max_tokens: 1024,
    system: classifySystemPrompt(universe),
    tools: [classifyTool()],
    tool_choice: { type: "tool", name: "classify_event" },
    messages: [classifyUserMessage(event)],
  });
  const latency = Date.now() - start;

  // Find the tool_use block and validate its input.
  const toolUse = response.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) {
    throw new Error(
      `Classifier returned no tool_use block. Stop reason: ${response.stop_reason}`,
    );
  }

  const parsed = ToolInputSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(
      `Classifier tool input failed validation: ${parsed.error.message}\n` +
        `Raw input: ${JSON.stringify(toolUse.input).slice(0, 500)}`,
    );
  }

  const result: ClassificationResult = {
    event_id: event.id,
    ...parsed.data,
    tokens: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      cached: response.usage.cache_read_input_tokens ?? 0,
    },
    latency_ms: latency,
  };

  if (persist) {
    Classifications.upsertClassification({
      event_id: event.id,
      event_type: result.event_type,
      sentiment: result.sentiment,
      severity: result.severity,
      confidence: result.confidence,
      actionable: result.actionable,
      event_recency: result.event_recency,
      affected_asset_ids: result.affected_asset_ids,
      reasoning: result.reasoning,
      model,
      prompt_version: CLASSIFY_PROMPT_VERSION,
      // D1: stash the embedding and continuation pointer alongside the
      // classification so future freshness checks can compare against
      // this row, and downstream conviction can read coverage_continuation_of.
      embedding: options?.embedding ?? null,
      coverage_continuation_of: options?.coverageContinuationOf ?? null,
      // D3: persist the reasoning fields when the model supplied them.
      // Older v5 model output won't include these — we tolerate undefined.
      mechanism_length: result.mechanism_length ?? null,
      mechanism_reasoning: result.mechanism_reasoning ?? null,
      counterfactual_strength: result.counterfactual_strength ?? null,
      counterfactual_reasoning: result.counterfactual_reasoning ?? null,
    });

    // Link Claude's affected_asset_ids into event_assets as 'inferred'.
    Events.linkEventAssets(
      event.id,
      result.affected_asset_ids,
      "inferred",
    );
  }

  return result;
}

/**
 * Classify a batch of events sequentially.
 *
 * Sequential (not parallel) for two reasons:
 *   1) Anthropic prompt cache prefers cache hits on consecutive calls
 *   2) keeps us under the per-minute rate limit on lower tiers
 *
 * Returns aggregate stats + per-event results.
 */
export async function classifyBatch(
  events: StoredEvent[],
  options?: {
    universe?: Asset[];
    /** D1: per-event pre-computed embeddings (computed at ingest time). */
    embeddings?: Map<string, number[]>;
    /** D1: per-event continuation pointers when freshness gate flagged
     *      this article as low-novelty against a prior event. */
    coverageContinuations?: Map<string, string>;
  },
): Promise<{
  results: ClassificationResult[];
  errors: Array<{ event_id: string; error: string }>;
  totals: { input: number; output: number; cached: number; latency_ms: number };
}> {
  const results: ClassificationResult[] = [];
  const errors: Array<{ event_id: string; error: string }> = [];
  const totals = { input: 0, output: 0, cached: 0, latency_ms: 0 };

  for (const e of events) {
    try {
      const r = await classifyEvent(e, {
        ...options,
        embedding: options?.embeddings?.get(e.id),
        coverageContinuationOf: options?.coverageContinuations?.get(e.id),
      });
      results.push(r);
      totals.input += r.tokens.input;
      totals.output += r.tokens.output;
      totals.cached += r.tokens.cached;
      totals.latency_ms += r.latency_ms;
    } catch (err) {
      errors.push({
        event_id: e.id,
        error: (err as Error).message ?? String(err),
      });
    }
  }

  return { results, errors, totals };
}
