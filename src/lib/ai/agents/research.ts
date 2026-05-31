/**
 * Research agent — the first agentic feature in Helix (Wave 2).
 *
 * Takes a news event and produces a structured classification. Unlike the
 * Wave 1 classifier (single-shot LLM call), this agent decides what
 * evidence to gather, calls tools to fetch it, and iterates until it has
 * enough information to commit. Every step is recorded to `agent_traces`
 * so the audit page can render the full reasoning chain.
 *
 * Output shape mirrors the existing `Classification` type so the rest of
 * the pipeline keeps working unchanged — the agent is a drop-in upgrade
 * for the classifier path when AGENT_CLASSIFIER=1 is set.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { anthropic, getModel } from "@/lib/ai/client";
import {
  AgentTraces,
  type AgentStep,
} from "@/lib/db";
import type { StoredEvent } from "@/lib/db/repos/events";
import type {
  Classification,
  EventType,
  Sentiment,
  Severity,
} from "@/lib/db/repos/classifications";

import { searchOutletCoverageTool } from "./tools/search-outlet-coverage";
import { assetHistoryTool } from "./tools/asset-history";
import { eventTypeStatsTool } from "./tools/event-type-stats";
import type { AgentTool } from "./tools/types";

// ─────────────────────────────────────────────────────────────────────────
// Pricing / config
// ─────────────────────────────────────────────────────────────────────────

const PRICING = { input: 3, cached: 0.3, output: 15 }; // per 1M tokens
const MAX_ROUNDS = 6;
const MAX_OUTPUT_TOKENS = 2000;

// Registry of tools the research agent can call. Adding a tool here is
// the only place you wire it in — the loop reads from the same map for
// both the Anthropic spec and the local handler.
const TOOLS: Record<string, AgentTool> = {
  search_outlet_coverage: searchOutletCoverageTool as AgentTool,
  query_asset_history: assetHistoryTool as AgentTool,
  query_event_type_stats: eventTypeStatsTool as AgentTool,
};

// ─────────────────────────────────────────────────────────────────────────
// Final-classify tool — the agent emits its conclusion via this tool call
// (forced tool_choice). Structured-output → no parsing brittleness.
// ─────────────────────────────────────────────────────────────────────────

const EVENT_TYPES = [
  "exploit","regulatory","etf_flow","partnership","listing",
  "social_platform","unlock","airdrop","earnings","macro","treasury",
  "governance","tech_update","security","narrative","fundraising","other",
] as const;

const classifyTool: Anthropic.Tool = {
  name: "submit_classification",
  description:
    "Submit your final classification of the news event. Call this " +
    "EXACTLY ONCE after gathering whatever evidence you need. The fields " +
    "should reflect your final judgment after considering the tool " +
    "outputs. `reasoning` should reference the specific evidence you " +
    "found (e.g. 'corroborated by 3 outlets including Bloomberg and " +
    "Reuters; query_event_type_stats showed 71% 3d hit rate for this " +
    "category').",
  input_schema: {
    type: "object",
    required: [
      "event_type",
      "sentiment",
      "severity",
      "confidence",
      "actionable",
      "event_recency",
      "affected_asset_ids",
      "reasoning",
    ],
    properties: {
      event_type: {
        type: "string",
        enum: [...EVENT_TYPES],
        description: "Fixed taxonomy — pick the closest match.",
      },
      sentiment: {
        type: "string",
        enum: ["positive", "negative", "neutral"],
      },
      severity: {
        type: "string",
        enum: ["high", "medium", "low"],
      },
      confidence: {
        type: "number",
        description: "0..1. Your conviction after gathering evidence.",
      },
      actionable: {
        type: "boolean",
        description:
          "Whether a trader could profitably act on this RIGHT NOW " +
          "(false for retrospective digests, summaries, opinion pieces).",
      },
      event_recency: {
        type: "string",
        enum: ["live", "today", "this_week", "older"],
        description: "When the underlying event happened (not the publish time).",
      },
      affected_asset_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Asset ids from the provided universe that this event affects. " +
          "Use the EXACT ids shown (e.g. 'tok-btc', 'trs-mstr').",
      },
      reasoning: {
        type: "string",
        description:
          "1-3 sentences citing the specific tool outputs that shaped " +
          "your decision. This becomes the public audit reasoning.",
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────

function systemPrompt(universe: Array<{ id: string; symbol: string; name: string; kind: string }>): string {
  const universeList = universe
    .slice(0, 100)
    .map((a) => `  ${a.id} (${a.symbol}) — ${a.kind}`)
    .join("\n");

  return [
    "You are Helix's research agent.",
    "",
    "Your job: classify a news headline into a structured signal-ready",
    "form, but UNLIKE a single-shot classifier you can use tools to",
    "gather evidence before committing. You should call tools when:",
    "  - the headline is ambiguous (you'd want corroboration before",
    "    treating it as a real catalyst)",
    "  - the asset has been trading in a way that contradicts the",
    "    proposed direction",
    "  - you want to calibrate conviction against measured base rates",
    "",
    "GUIDELINES:",
    "  - Don't burn rounds on obviously-clear news. If a Reuters",
    "    headline names a CEO change at a major company, just classify.",
    "  - If the headline mentions a specific asset, query_asset_history",
    "    is usually worth one call.",
    "  - If you're proposing a high-conviction direction, calling",
    "    query_event_type_stats is a good idea — measured hit rates often",
    "    contradict the model's intuition.",
    "  - Cite specific tool results in your final `reasoning` string.",
    "",
    "AVAILABLE ASSETS (use the exact id):",
    universeList,
    universe.length > 100 ? `  ... and ${universe.length - 100} more` : "",
    "",
    "When you have enough evidence, call submit_classification EXACTLY",
    "ONCE with your final answer.",
  ].join("\n");
}

function buildInitialUserContent(event: StoredEvent): string {
  return [
    `Classify this news event:`,
    ``,
    `Title: ${event.title}`,
    `Author: ${event.author ?? "(unknown)"}`,
    `Released: ${new Date(event.release_time).toISOString()}`,
    event.content
      ? `Body (first 400 chars): ${event.content.slice(0, 400)}`
      : "",
    event.matched_currencies && event.matched_currencies.length > 0
      ? `SoSoValue-matched currencies: ${event.matched_currencies
          .map((c) => c.symbol)
          .join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Result shape
// ─────────────────────────────────────────────────────────────────────────

export interface ResearchAgentResult {
  trace_id: string;
  classification: Omit<Classification, "classified_at"> | null;
  rounds: number;
  tokens: { input: number; output: number; cached: number };
  cost_usd: number;
  /** When the agent failed to converge or errored, this is set. */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// The loop
// ─────────────────────────────────────────────────────────────────────────

export async function runResearchAgent(input: {
  event: StoredEvent;
  universe: Array<{ id: string; symbol: string; name: string; kind: string }>;
}): Promise<ResearchAgentResult> {
  const traceId = randomUUID();
  const model = getModel();

  await AgentTraces.startTrace({
    id: traceId,
    agent_name: "research",
    event_id: input.event.id,
    model,
  });

  const client = anthropic();
  const tools: Anthropic.Tool[] = [
    ...Object.values(TOOLS).map((t) => t.spec),
    classifyTool,
  ];

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: buildInitialUserContent(input.event) },
  ];

  let rounds = 0;
  const tokens = { input: 0, output: 0, cached: 0 };
  let finalClassification: ResearchAgentResult["classification"] = null;
  let agentError: string | undefined;

  try {
    for (rounds = 0; rounds < MAX_ROUNDS; rounds++) {
      const resp = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt(input.universe),
        tools,
        messages,
      });
      tokens.input += resp.usage.input_tokens;
      tokens.output += resp.usage.output_tokens;
      tokens.cached +=
        (resp.usage as unknown as { cache_read_input_tokens?: number })
          .cache_read_input_tokens ?? 0;

      // Record the agent's thinking content (any text blocks).
      const textBlocks = resp.content.filter(
        (b): b is Anthropic.Messages.TextBlock => b.type === "text",
      );
      if (textBlocks.length > 0) {
        const thinking = textBlocks.map((b) => b.text).join("\n").trim();
        if (thinking) {
          await AgentTraces.appendStep(traceId, {
            type: "thinking",
            round: rounds,
            content: thinking,
            ts_ms: Date.now(),
          } satisfies AgentStep);
        }
      }

      const toolUses = resp.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      );

      // Look for the final classification call first.
      const submitCall = toolUses.find(
        (b) => b.name === "submit_classification",
      );
      if (submitCall) {
        const parsed = parseClassification(input.event.id, submitCall.input);
        if (parsed.ok) {
          finalClassification = parsed.value;
          await AgentTraces.appendStep(traceId, {
            type: "final",
            round: rounds,
            output: parsed.value,
            ts_ms: Date.now(),
          } satisfies AgentStep);
          break;
        } else {
          // Bad output shape — record the error and let the agent retry.
          await AgentTraces.appendStep(traceId, {
            type: "tool_call",
            round: rounds,
            tool: "submit_classification",
            input: submitCall.input,
            output: null,
            duration_ms: 0,
            error: parsed.error,
            ts_ms: Date.now(),
          } satisfies AgentStep);
          messages.push({ role: "assistant", content: resp.content });
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: submitCall.id,
                content: `Invalid output: ${parsed.error}. Try again with corrected fields.`,
                is_error: true,
              },
            ],
          });
          continue;
        }
      }

      // No final-call yet — run the requested data tools.
      if (toolUses.length === 0) {
        // Agent ended turn without calling anything actionable. Nudge it.
        messages.push({ role: "assistant", content: resp.content });
        messages.push({
          role: "user",
          content:
            "You didn't call any tool. Either gather more evidence with " +
            "the available tools, or call submit_classification with " +
            "your final answer.",
        });
        continue;
      }

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const t of toolUses) {
        const tool = TOOLS[t.name];
        const startedAt = Date.now();
        if (!tool) {
          await AgentTraces.appendStep(traceId, {
            type: "tool_call",
            round: rounds,
            tool: t.name,
            input: t.input,
            output: null,
            duration_ms: 0,
            error: "unknown tool",
            ts_ms: startedAt,
          } satisfies AgentStep);
          toolResults.push({
            type: "tool_result",
            tool_use_id: t.id,
            content: `Error: unknown tool '${t.name}'`,
            is_error: true,
          });
          continue;
        }
        try {
          const out = await tool.handle(t.input as never);
          const durationMs = Date.now() - startedAt;
          await AgentTraces.appendStep(traceId, {
            type: "tool_call",
            round: rounds,
            tool: t.name,
            input: t.input,
            output: out,
            duration_ms: durationMs,
            ts_ms: startedAt,
          } satisfies AgentStep);
          toolResults.push({
            type: "tool_result",
            tool_use_id: t.id,
            content: JSON.stringify(out).slice(0, 8000),
          });
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          const msg = (err as Error).message ?? String(err);
          await AgentTraces.appendStep(traceId, {
            type: "tool_call",
            round: rounds,
            tool: t.name,
            input: t.input,
            output: null,
            duration_ms: durationMs,
            error: msg,
            ts_ms: startedAt,
          } satisfies AgentStep);
          toolResults.push({
            type: "tool_result",
            tool_use_id: t.id,
            content: `Tool error: ${msg}`,
            is_error: true,
          });
        }
      }

      messages.push({ role: "assistant", content: resp.content });
      messages.push({ role: "user", content: toolResults });
    }

    if (!finalClassification) {
      agentError = `agent did not converge in ${MAX_ROUNDS} rounds`;
    }
  } catch (err) {
    agentError = (err as Error).message ?? String(err);
  }

  const cost_usd =
    (tokens.input * PRICING.input +
      tokens.cached * PRICING.cached +
      tokens.output * PRICING.output) /
    1_000_000;

  await AgentTraces.finishTrace(traceId, {
    status: finalClassification && !agentError ? "ok" : "error",
    final_output: finalClassification ?? undefined,
    error: agentError,
    tokens,
    cost_usd,
  });

  return {
    trace_id: traceId,
    classification: finalClassification,
    rounds,
    tokens,
    cost_usd,
    error: agentError,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function parseClassification(
  eventId: string,
  raw: unknown,
):
  | { ok: true; value: Omit<Classification, "classified_at"> }
  | { ok: false; error: string } {
  if (typeof raw !== "object" || raw == null) {
    return { ok: false, error: "tool input was not an object" };
  }
  const o = raw as Record<string, unknown>;
  if (!EVENT_TYPES.includes(o.event_type as EventType)) {
    return { ok: false, error: `invalid event_type: ${o.event_type}` };
  }
  if (!["positive", "negative", "neutral"].includes(o.sentiment as string)) {
    return { ok: false, error: `invalid sentiment: ${o.sentiment}` };
  }
  if (!["high", "medium", "low"].includes(o.severity as string)) {
    return { ok: false, error: `invalid severity: ${o.severity}` };
  }
  const confidence = Number(o.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, error: `invalid confidence: ${o.confidence}` };
  }
  const affected = o.affected_asset_ids;
  if (!Array.isArray(affected) || affected.some((x) => typeof x !== "string")) {
    return { ok: false, error: "affected_asset_ids must be string[]" };
  }
  if (typeof o.reasoning !== "string" || o.reasoning.trim().length === 0) {
    return { ok: false, error: "reasoning required" };
  }
  const recency = o.event_recency as string;
  if (!["live", "today", "this_week", "older"].includes(recency)) {
    return { ok: false, error: `invalid event_recency: ${recency}` };
  }
  const actionable = Boolean(o.actionable);
  return {
    ok: true,
    value: {
      event_id: eventId,
      event_type: o.event_type as EventType,
      sentiment: o.sentiment as Sentiment,
      severity: o.severity as Severity,
      confidence,
      actionable,
      event_recency: recency as Classification["event_recency"],
      affected_asset_ids: affected as string[],
      reasoning: (o.reasoning as string).trim(),
      model: getModel(),
      prompt_version: "research-agent-v1",
    },
  };
}
