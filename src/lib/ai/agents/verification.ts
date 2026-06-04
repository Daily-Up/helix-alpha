/**
 * Verification agent (Wave 2).
 *
 * Runs AFTER signal generation and BEFORE a signal is allowed to reach
 * AUTO tier. The signal generator's tier is treated as a proposal; this
 * agent's job is to challenge it.
 *
 * What it checks:
 *   - Has the price already moved (query_price_around_catalyst)?
 *   - Is the source corroborated (search_outlet_coverage)?
 *   - Has this asset been recently wrong (query_asset_history)?
 *   - Does the historical base rate support the proposed conviction
 *     (query_base_rate + query_event_type_stats)?
 *
 * Output: a structured verdict — keep, downgrade (with new tier), or
 * kill (with reason). The trace is logged to agent_traces and surfaces
 * on the audit page beside the research-agent trace.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { anthropic, getModel } from "@/lib/ai/client";
import {
  AgentTraces,
  type AgentStep,
  type SignalRow,
} from "@/lib/db";

import { searchOutletCoverageTool } from "./tools/search-outlet-coverage";
import { assetHistoryTool } from "./tools/asset-history";
import { eventTypeStatsTool } from "./tools/event-type-stats";
import { queryBaseRateTool } from "./tools/query-base-rate";
import { queryPriceAroundCatalystTool } from "./tools/query-price-around-catalyst";
import { queryMarketRegimeTool } from "./tools/query-market-regime";
import { querySimilarCatalystTool } from "./tools/query-similar-catalyst";
import { queryMacroContextTool } from "./tools/query-macro-context";
import type { AgentTool } from "./tools/types";
import { getMarketPulse, formatPulseForPrompt } from "@/lib/regime/snapshot";

const PRICING = { input: 3, cached: 0.3, output: 15 };
const MAX_ROUNDS = 5;
const MAX_OUTPUT_TOKENS = 1500;

// Verification agent has access to the diagnostic tools, but not
// fetch_full_article — by the time we're verifying we've already done
// the heavy reading work in research. Keeps verification fast + cheap.
const TOOLS: Record<string, AgentTool> = {
  search_outlet_coverage: searchOutletCoverageTool as AgentTool,
  query_asset_history: assetHistoryTool as AgentTool,
  query_event_type_stats: eventTypeStatsTool as AgentTool,
  query_base_rate: queryBaseRateTool as AgentTool,
  query_price_around_catalyst: queryPriceAroundCatalystTool as AgentTool,
  query_market_regime: queryMarketRegimeTool as AgentTool,
  query_similar_catalyst: querySimilarCatalystTool as AgentTool,
  query_macro_context: queryMacroContextTool as AgentTool,
};

const verdictTool: Anthropic.Tool = {
  name: "submit_verdict",
  description:
    "Submit your verification verdict EXACTLY ONCE after gathering " +
    "enough evidence. `decision` should reflect your final judgment " +
    "about whether the proposed signal is safe to execute at the " +
    "proposed tier.",
  input_schema: {
    type: "object",
    required: ["decision", "reasoning"],
    properties: {
      decision: {
        type: "string",
        enum: ["confirm", "downgrade", "kill"],
        description:
          "'confirm' = let the signal fire at proposed tier; " +
          "'downgrade' = the proposal is plausible but evidence is " +
          "thin — drop to a lower tier; " +
          "'kill' = something specific is wrong (price already moved, " +
          "no corroboration on a single-source story, contradicted by " +
          "recent base rates).",
      },
      new_tier: {
        type: "string",
        enum: ["auto", "review", "info"],
        description:
          "Required when decision='downgrade'. The tier to drop to.",
      },
      reasoning: {
        type: "string",
        description:
          "2-4 sentences citing the specific evidence that drove the " +
          "verdict. Cite numbers (e.g. 'price already up 9% intraday', " +
          "'base rate cell n=12 with mean 3.5% move').",
      },
      red_flags: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional — concrete issues found, e.g. ['single_source', " +
          "'price_already_moved', 'asset_recently_wrong'].",
      },
    },
  },
};

function systemPrompt(marketPulse?: string): string {
  return [
    "You are Helix's verification agent.",
    marketPulse ? "\n" + marketPulse + "\n" : "",
    "",
    "A signal generator just proposed a trade. Your job is to STRESS-",
    "TEST that proposal before it executes. You are not arguing in",
    "favor of the trade — you are looking for reasons it might be",
    "wrong, and downgrading or killing it when the evidence supports.",
    "",
    "DEFAULT POSTURE: skeptical. Confirm only when multiple checks line",
    "up. If anything looks off — price already moved, single source, no",
    "base rate, contradicted by recent asset history — that's enough",
    "to downgrade or kill.",
    "",
    "CHECKS YOU SHOULD ALMOST ALWAYS RUN:",
    "  1. query_price_around_catalyst — has the move already happened?",
    "  2. search_outlet_coverage — single source = single point of failure.",
    "  3. query_base_rate or query_event_type_stats — does measured",
    "     history support the proposed conviction band?",
    "",
    "TIER GUIDANCE:",
    "  - 'confirm' AUTO requires: corroborated source AND historical base",
    "    rate supports it AND price has NOT already moved most of the way.",
    "  - 'downgrade' to REVIEW when the signal looks real but you can't",
    "    fully verify one of those three.",
    "  - 'kill' when something specific contradicts the trade (price",
    "    already up 9% by the time the news landed, etc.).",
    "",
    "When you have enough evidence, call submit_verdict ONCE.",
  ].join("\n");
}

function buildInitialUserContent(input: {
  signal: SignalRow;
  asset_symbol: string;
  catalyst_iso: string;
  catalyst_title: string;
  catalyst_author: string | null;
}): string {
  const s = input.signal;
  return [
    `Verify this proposed signal.`,
    ``,
    `Proposal:`,
    `  asset = ${input.asset_symbol} (${s.asset_id})`,
    `  direction = ${s.direction}`,
    `  proposed_tier = ${s.tier}`,
    `  conviction = ${s.confidence.toFixed(2)}`,
    `  expected_horizon = ${s.expected_horizon ?? "(none)"}`,
    `  catalyst_subtype = ${s.catalyst_subtype ?? "(none)"}`,
    `  significance_score = ${s.significance_score ?? "(none)"}`,
    ``,
    `Catalyst:`,
    `  title = ${input.catalyst_title}`,
    `  author = ${input.catalyst_author ?? "(unknown)"}`,
    `  released = ${input.catalyst_iso}`,
    ``,
    `Decide: confirm, downgrade, or kill — and explain why with cited`,
    `tool results.`,
  ].join("\n");
}

export interface VerificationVerdict {
  decision: "confirm" | "downgrade" | "kill";
  new_tier?: "auto" | "review" | "info";
  reasoning: string;
  red_flags?: string[];
}

export interface VerificationResult {
  trace_id: string;
  verdict: VerificationVerdict | null;
  rounds: number;
  tokens: { input: number; output: number; cached: number };
  cost_usd: number;
  error?: string;
}

export async function runVerificationAgent(input: {
  signal: SignalRow;
  asset_symbol: string;
  catalyst_iso: string;
  catalyst_title: string;
  catalyst_author: string | null;
  /** Pre-assigned trace id, so callers can return it before the
   *  agent has started running and poll for live progress. */
  traceId?: string;
}): Promise<VerificationResult> {
  const traceId = input.traceId ?? randomUUID();
  const model = getModel();

  let marketPulse: string | undefined;
  try {
    const pulse = await getMarketPulse();
    marketPulse = formatPulseForPrompt(pulse);
  } catch (e) {
    console.warn(`[verification-agent] market pulse failed: ${(e as Error).message}`);
  }

  await AgentTraces.startTrace({
    id: traceId,
    agent_name: "verification",
    event_id: input.signal.triggered_by_event_id,
    signal_id: input.signal.id,
    model,
  });

  const client = anthropic();
  const tools: Anthropic.Tool[] = [
    ...Object.values(TOOLS).map((t) => t.spec),
    verdictTool,
  ];

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: buildInitialUserContent(input) },
  ];

  let rounds = 0;
  const tokens = { input: 0, output: 0, cached: 0 };
  let verdict: VerificationVerdict | null = null;
  let agentError: string | undefined;

  try {
    for (rounds = 0; rounds < MAX_ROUNDS; rounds++) {
      const resp = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt(marketPulse),
        tools,
        messages,
      });
      tokens.input += resp.usage.input_tokens;
      tokens.output += resp.usage.output_tokens;
      tokens.cached +=
        (resp.usage as unknown as { cache_read_input_tokens?: number })
          .cache_read_input_tokens ?? 0;

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

      const submit = toolUses.find((b) => b.name === "submit_verdict");
      if (submit) {
        const parsed = parseVerdict(submit.input);
        if (parsed.ok) {
          verdict = parsed.value;
          await AgentTraces.appendStep(traceId, {
            type: "final",
            round: rounds,
            output: parsed.value,
            ts_ms: Date.now(),
          } satisfies AgentStep);
          break;
        } else {
          await AgentTraces.appendStep(traceId, {
            type: "tool_call",
            round: rounds,
            tool: "submit_verdict",
            input: submit.input,
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
                tool_use_id: submit.id,
                content: `Invalid verdict: ${parsed.error}. Try again with corrected fields.`,
                is_error: true,
              },
            ],
          });
          continue;
        }
      }

      if (toolUses.length === 0) {
        messages.push({ role: "assistant", content: resp.content });
        messages.push({
          role: "user",
          content:
            "You didn't call a tool. Either gather more evidence with the " +
            "available tools, or call submit_verdict with your final answer.",
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

    if (!verdict) {
      agentError = `verification did not converge in ${MAX_ROUNDS} rounds`;
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
    status: verdict && !agentError ? "ok" : "error",
    final_output: verdict ?? undefined,
    error: agentError,
    tokens,
    cost_usd,
  });

  return {
    trace_id: traceId,
    verdict,
    rounds,
    tokens,
    cost_usd,
    error: agentError,
  };
}

function parseVerdict(
  raw: unknown,
):
  | { ok: true; value: VerificationVerdict }
  | { ok: false; error: string } {
  if (typeof raw !== "object" || raw == null) {
    return { ok: false, error: "verdict input was not an object" };
  }
  const o = raw as Record<string, unknown>;
  const decision = o.decision;
  if (decision !== "confirm" && decision !== "downgrade" && decision !== "kill") {
    return { ok: false, error: `invalid decision: ${decision}` };
  }
  const reasoning = o.reasoning;
  if (typeof reasoning !== "string" || reasoning.trim().length === 0) {
    return { ok: false, error: "reasoning required" };
  }
  if (decision === "downgrade") {
    const nt = o.new_tier;
    if (nt !== "auto" && nt !== "review" && nt !== "info") {
      return { ok: false, error: "downgrade requires valid new_tier" };
    }
  }
  const value: VerificationVerdict = {
    decision,
    reasoning: reasoning.trim(),
  };
  if (decision === "downgrade") {
    value.new_tier = o.new_tier as VerificationVerdict["new_tier"];
  }
  if (Array.isArray(o.red_flags)) {
    value.red_flags = (o.red_flags as unknown[]).filter(
      (x): x is string => typeof x === "string",
    );
  }
  return { ok: true, value };
}
