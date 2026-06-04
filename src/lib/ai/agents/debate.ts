/**
 * Debate agent (Wave 2 / Wave 3 hybrid).
 *
 * For borderline-conviction signals (REVIEW band, 0.50-0.65), a single
 * agent's verdict can be overconfident either way. Debate runs THREE
 * agents:
 *
 *   1. Bull agent — must argue the trade IS sound. Has tools, builds a
 *      case using evidence.
 *   2. Bear agent — must argue the trade is NOT sound. Same tools,
 *      adversarial framing.
 *   3. Synthesizer — reads both transcripts, weighs the strongest
 *      arguments, decides: confirm / downgrade / kill, with reasoning
 *      that explicitly references the strongest points from each side.
 *
 * The whole debate is logged to agent_traces (one row per agent: bull,
 * bear, synthesizer) and surfaces on the audit page as a thread.
 *
 * What makes this a Wave-2 differentiator:
 *   Every other AI product gives you ONE verdict. Helix shows you the
 *   thesis, the antithesis, AND the synthesis — with every supporting
 *   tool call inspectable. That's the trust-through-transparency
 *   philosophy taken to its extreme.
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
import type { AgentTool } from "./tools/types";
import { getMarketPulse, formatPulseForPrompt } from "@/lib/regime/snapshot";

const PRICING = { input: 3, cached: 0.3, output: 15 };
const MAX_ROUNDS_PER_SIDE = 4;
const MAX_OUTPUT_TOKENS = 1200;

const TOOLS: Record<string, AgentTool> = {
  search_outlet_coverage: searchOutletCoverageTool as AgentTool,
  query_asset_history: assetHistoryTool as AgentTool,
  query_event_type_stats: eventTypeStatsTool as AgentTool,
  query_base_rate: queryBaseRateTool as AgentTool,
  query_price_around_catalyst: queryPriceAroundCatalystTool as AgentTool,
};

const sideTool: Anthropic.Tool = {
  name: "submit_argument",
  description:
    "Submit your final, fully-formed argument for or against this trade. " +
    "Call EXACTLY ONCE after gathering enough evidence.",
  input_schema: {
    type: "object",
    required: ["thesis", "key_evidence", "weakest_point"],
    properties: {
      thesis: {
        type: "string",
        description:
          "1-2 sentence summary of your side's position. If bull: why " +
          "the trade IS sound. If bear: why the trade is NOT sound.",
      },
      key_evidence: {
        type: "array",
        items: { type: "string" },
        description:
          "3-5 specific evidentiary points with numbers, citing tool " +
          "results (e.g. 'price already up 9% intraday per " +
          "query_price_around_catalyst').",
      },
      weakest_point: {
        type: "string",
        description:
          "What's the strongest counter-argument to your own thesis? " +
          "Forces both sides to acknowledge real opposition.",
      },
    },
  },
};

const synthesizerTool: Anthropic.Tool = {
  name: "submit_synthesis",
  description:
    "Read both arguments and submit the final verdict. Call EXACTLY ONCE.",
  input_schema: {
    type: "object",
    required: ["decision", "reasoning"],
    properties: {
      decision: {
        type: "string",
        enum: ["confirm", "downgrade", "kill"],
        description:
          "Final action on the signal. Same semantics as the verification agent.",
      },
      new_tier: {
        type: "string",
        enum: ["auto", "review", "info"],
      },
      reasoning: {
        type: "string",
        description:
          "Explicitly reference the strongest bull point AND the " +
          "strongest bear point, then explain which dominated and why.",
      },
      winning_side: {
        type: "string",
        enum: ["bull", "bear", "neither"],
      },
    },
  },
};

interface SideArgument {
  thesis: string;
  key_evidence: string[];
  weakest_point: string;
}

interface Synthesis {
  decision: "confirm" | "downgrade" | "kill";
  new_tier?: "auto" | "review" | "info";
  reasoning: string;
  winning_side: "bull" | "bear" | "neither";
}

export interface DebateResult {
  bull_trace_id: string;
  bear_trace_id: string;
  synthesizer_trace_id: string;
  bull_argument: SideArgument | null;
  bear_argument: SideArgument | null;
  synthesis: Synthesis | null;
  total_rounds: number;
  total_tokens: { input: number; output: number; cached: number };
  total_cost_usd: number;
  error?: string;
}

export async function runDebateAgent(input: {
  signal: SignalRow;
  asset_symbol: string;
  catalyst_iso: string;
  catalyst_title: string;
  catalyst_author: string | null;
}): Promise<DebateResult> {
  const totals = { input: 0, output: 0, cached: 0 };

  // Run bull and bear IN PARALLEL — they don't see each other's work,
  // so concurrent execution is correct and roughly halves wall-clock
  // (matters because the 3-agent run has to fit in a 60s Vercel function).
  const [bull, bear] = await Promise.all([
    runSide("bull", input),
    runSide("bear", input),
  ]);
  for (const side of [bull, bear]) {
    totals.input += side.tokens.input;
    totals.output += side.tokens.output;
    totals.cached += side.tokens.cached;
  }

  const synth = await runSynthesizer({
    signal: input.signal,
    asset_symbol: input.asset_symbol,
    catalyst_title: input.catalyst_title,
    bull: bull.argument,
    bear: bear.argument,
  });
  totals.input += synth.tokens.input;
  totals.output += synth.tokens.output;
  totals.cached += synth.tokens.cached;

  const total_cost_usd =
    (totals.input * PRICING.input +
      totals.cached * PRICING.cached +
      totals.output * PRICING.output) /
    1_000_000;

  return {
    bull_trace_id: bull.trace_id,
    bear_trace_id: bear.trace_id,
    synthesizer_trace_id: synth.trace_id,
    bull_argument: bull.argument,
    bear_argument: bear.argument,
    synthesis: synth.synthesis,
    total_rounds: bull.rounds + bear.rounds + synth.rounds,
    total_tokens: totals,
    total_cost_usd,
    error: bull.error ?? bear.error ?? synth.error,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// One side of the debate (bull or bear). Uses the same tool loop as the
// research agent, but with a side-specific system prompt and a
// submit_argument tool instead of a submit_classification.
// ─────────────────────────────────────────────────────────────────────────

interface SideResult {
  trace_id: string;
  argument: SideArgument | null;
  rounds: number;
  tokens: { input: number; output: number; cached: number };
  error?: string;
}

async function runSide(
  side: "bull" | "bear",
  input: {
    signal: SignalRow;
    asset_symbol: string;
    catalyst_iso: string;
    catalyst_title: string;
    catalyst_author: string | null;
  },
): Promise<SideResult> {
  const traceId = randomUUID();
  const model = getModel();

  let marketPulse: string | undefined;
  try {
    const pulse = await getMarketPulse();
    marketPulse = formatPulseForPrompt(pulse);
  } catch (e) {
    console.warn(`[debate-${side}] market pulse failed: ${(e as Error).message}`);
  }

  await AgentTraces.startTrace({
    id: traceId,
    agent_name: `debate-${side}`,
    event_id: input.signal.triggered_by_event_id,
    signal_id: input.signal.id,
    model,
  });

  const client = anthropic();
  const tools: Anthropic.Tool[] = [
    ...Object.values(TOOLS).map((t) => t.spec),
    sideTool,
  ];

  const sys =
    side === "bull"
      ? [
          "You are the BULL agent in a structured debate about whether to",
          "execute a proposed trade.",
          marketPulse ? "\n" + marketPulse + "\n" : "",
          "Your assignment: argue the trade IS sound. Find the evidence",
          "that supports executing at the proposed tier. Use tools to",
          "build a case grounded in numbers, then submit_argument with",
          "your thesis, key_evidence (3-5 cited points), and the",
          "weakest_point you can identify against your own thesis.",
          "",
          "Be RIGOROUS, not cheerleading. A bull case that doesn't survive",
          "the bear's strongest counter is worthless.",
        ].join("\n")
      : [
          "You are the BEAR agent in a structured debate about whether to",
          "execute a proposed trade.",
          marketPulse ? "\n" + marketPulse + "\n" : "",
          "Your assignment: argue the trade is NOT sound. Find the",
          "evidence that supports downgrading or killing it. Use tools",
          "to build a case grounded in numbers, then submit_argument",
          "with your thesis, key_evidence (3-5 cited points), and the",
          "weakest_point you can identify against your own thesis.",
          "",
          "Be RIGOROUS, not contrarian. A bear case that depends on",
          "ignoring real positives is worthless.",
        ].join("\n");

  const initial = [
    `Proposed trade:`,
    `  asset = ${input.asset_symbol} (${input.signal.asset_id})`,
    `  direction = ${input.signal.direction}`,
    `  proposed_tier = ${input.signal.tier}`,
    `  conviction = ${input.signal.confidence.toFixed(2)}`,
    `  catalyst_subtype = ${input.signal.catalyst_subtype ?? "(none)"}`,
    ``,
    `Catalyst:`,
    `  title = ${input.catalyst_title}`,
    `  author = ${input.catalyst_author ?? "(unknown)"}`,
    `  released = ${input.catalyst_iso}`,
    ``,
    side === "bull"
      ? `Build the strongest possible case FOR this trade.`
      : `Build the strongest possible case AGAINST this trade.`,
  ].join("\n");

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: initial },
  ];
  let rounds = 0;
  const tokens = { input: 0, output: 0, cached: 0 };
  let argument: SideArgument | null = null;
  let agentError: string | undefined;

  try {
    for (rounds = 0; rounds < MAX_ROUNDS_PER_SIDE; rounds++) {
      const resp = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: sys,
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
        const text = textBlocks.map((b) => b.text).join("\n").trim();
        if (text) {
          await AgentTraces.appendStep(traceId, {
            type: "thinking",
            round: rounds,
            content: text,
            ts_ms: Date.now(),
          } satisfies AgentStep);
        }
      }

      const toolUses = resp.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      );

      const submit = toolUses.find((b) => b.name === "submit_argument");
      if (submit) {
        const parsed = parseSideArgument(submit.input);
        if (parsed.ok) {
          argument = parsed.value;
          await AgentTraces.appendStep(traceId, {
            type: "final",
            round: rounds,
            output: parsed.value,
            ts_ms: Date.now(),
          } satisfies AgentStep);
          break;
        } else {
          messages.push({ role: "assistant", content: resp.content });
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: submit.id,
                content: `Invalid: ${parsed.error}. Retry.`,
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
            "Either call a tool to gather more evidence or call " +
            "submit_argument with your final case.",
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
          const msg = (err as Error).message ?? String(err);
          await AgentTraces.appendStep(traceId, {
            type: "tool_call",
            round: rounds,
            tool: t.name,
            input: t.input,
            output: null,
            duration_ms: Date.now() - startedAt,
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
    if (!argument) {
      agentError = `${side} side did not converge in ${MAX_ROUNDS_PER_SIDE} rounds`;
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
    status: argument && !agentError ? "ok" : "error",
    final_output: argument ?? undefined,
    error: agentError,
    tokens,
    cost_usd,
  });

  return { trace_id: traceId, argument, rounds, tokens, error: agentError };
}

// ─────────────────────────────────────────────────────────────────────────
// Synthesizer — reads both sides and renders a verdict.
// Doesn't get tools (it's reasoning over already-gathered evidence).
// ─────────────────────────────────────────────────────────────────────────

interface SynthResult {
  trace_id: string;
  synthesis: Synthesis | null;
  rounds: number;
  tokens: { input: number; output: number; cached: number };
  error?: string;
}

async function runSynthesizer(input: {
  signal: SignalRow;
  asset_symbol: string;
  catalyst_title: string;
  bull: SideArgument | null;
  bear: SideArgument | null;
}): Promise<SynthResult> {
  const traceId = randomUUID();
  const model = getModel();

  let marketPulse: string | undefined;
  try {
    const pulse = await getMarketPulse();
    marketPulse = formatPulseForPrompt(pulse);
  } catch (e) {
    console.warn(`[debate-synth] market pulse failed: ${(e as Error).message}`);
  }

  await AgentTraces.startTrace({
    id: traceId,
    agent_name: "debate-synth",
    event_id: input.signal.triggered_by_event_id,
    signal_id: input.signal.id,
    model,
  });

  const sys = [
    "You are the SYNTHESIZER agent in a structured debate. You have just",
    marketPulse ? "\n" + marketPulse + "\n" : "",
    "read the bull's case and the bear's case for executing a trade. Both",
    "had access to the same tools and built their arguments from real",
    "evidence.",
    "",
    "Your job: identify the SINGLE STRONGEST point from each side, decide",
    "which side's case actually dominates, and issue a verdict. Be honest",
    "about which arguments held up and which didn't.",
    "",
    "Use submit_synthesis to record your verdict. Your reasoning must",
    "EXPLICITLY reference the strongest bull point AND the strongest bear",
    "point, then explain which one carries more weight given the specific",
    "tools the agents called and the numbers they cited.",
  ].join("\n");

  const userText = [
    `Trade under debate:`,
    `  asset = ${input.asset_symbol}`,
    `  direction = ${input.signal.direction}`,
    `  proposed_tier = ${input.signal.tier}`,
    `  conviction = ${input.signal.confidence.toFixed(2)}`,
    `  catalyst = ${input.catalyst_title}`,
    ``,
    `BULL case:`,
    input.bull
      ? [
          `  thesis: ${input.bull.thesis}`,
          `  evidence:`,
          ...input.bull.key_evidence.map((e) => `    - ${e}`),
          `  acknowledged weakness: ${input.bull.weakest_point}`,
        ].join("\n")
      : `  (bull agent failed to produce an argument)`,
    ``,
    `BEAR case:`,
    input.bear
      ? [
          `  thesis: ${input.bear.thesis}`,
          `  evidence:`,
          ...input.bear.key_evidence.map((e) => `    - ${e}`),
          `  acknowledged weakness: ${input.bear.weakest_point}`,
        ].join("\n")
      : `  (bear agent failed to produce an argument)`,
    ``,
    `Synthesize the debate and submit your verdict.`,
  ].join("\n");

  const client = anthropic();
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: userText },
  ];
  const tokens = { input: 0, output: 0, cached: 0 };
  let synthesis: Synthesis | null = null;
  let agentError: string | undefined;
  let rounds = 0;

  try {
    for (rounds = 0; rounds < 3; rounds++) {
      const resp = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: sys,
        tools: [synthesizerTool],
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
        const text = textBlocks.map((b) => b.text).join("\n").trim();
        if (text) {
          await AgentTraces.appendStep(traceId, {
            type: "thinking",
            round: rounds,
            content: text,
            ts_ms: Date.now(),
          } satisfies AgentStep);
        }
      }

      const submit = resp.content.find(
        (b): b is Anthropic.Messages.ToolUseBlock =>
          b.type === "tool_use" && b.name === "submit_synthesis",
      );
      if (submit) {
        const parsed = parseSynthesis(submit.input);
        if (parsed.ok) {
          synthesis = parsed.value;
          await AgentTraces.appendStep(traceId, {
            type: "final",
            round: rounds,
            output: parsed.value,
            ts_ms: Date.now(),
          } satisfies AgentStep);
          break;
        } else {
          messages.push({ role: "assistant", content: resp.content });
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: submit.id,
                content: `Invalid: ${parsed.error}. Retry.`,
                is_error: true,
              },
            ],
          });
          continue;
        }
      }
      messages.push({ role: "assistant", content: resp.content });
      messages.push({
        role: "user",
        content: "Please call submit_synthesis with your verdict.",
      });
    }
    if (!synthesis) {
      agentError = "synthesizer did not produce a verdict";
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
    status: synthesis && !agentError ? "ok" : "error",
    final_output: synthesis ?? undefined,
    error: agentError,
    tokens,
    cost_usd,
  });

  return { trace_id: traceId, synthesis, rounds, tokens, error: agentError };
}

function parseSideArgument(
  raw: unknown,
): { ok: true; value: SideArgument } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw == null) {
    return { ok: false, error: "not an object" };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.thesis !== "string" || o.thesis.length === 0) {
    return { ok: false, error: "thesis required" };
  }
  if (
    !Array.isArray(o.key_evidence) ||
    o.key_evidence.length === 0 ||
    o.key_evidence.some((e) => typeof e !== "string")
  ) {
    return { ok: false, error: "key_evidence must be non-empty string[]" };
  }
  if (typeof o.weakest_point !== "string" || o.weakest_point.length === 0) {
    return { ok: false, error: "weakest_point required" };
  }
  return {
    ok: true,
    value: {
      thesis: o.thesis.trim(),
      key_evidence: (o.key_evidence as string[]).map((s) => s.trim()),
      weakest_point: o.weakest_point.trim(),
    },
  };
}

function parseSynthesis(
  raw: unknown,
): { ok: true; value: Synthesis } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw == null) {
    return { ok: false, error: "not an object" };
  }
  const o = raw as Record<string, unknown>;
  if (
    o.decision !== "confirm" &&
    o.decision !== "downgrade" &&
    o.decision !== "kill"
  ) {
    return { ok: false, error: `invalid decision: ${o.decision}` };
  }
  if (typeof o.reasoning !== "string" || o.reasoning.length === 0) {
    return { ok: false, error: "reasoning required" };
  }
  const winning = o.winning_side;
  if (winning !== "bull" && winning !== "bear" && winning !== "neither") {
    return { ok: false, error: "winning_side required" };
  }
  if (o.decision === "downgrade") {
    const nt = o.new_tier;
    if (nt !== "auto" && nt !== "review" && nt !== "info") {
      return { ok: false, error: "downgrade requires new_tier" };
    }
  }
  const v: Synthesis = {
    decision: o.decision,
    reasoning: (o.reasoning as string).trim(),
    winning_side: winning,
  };
  if (o.decision === "downgrade") {
    v.new_tier = o.new_tier as Synthesis["new_tier"];
  }
  return { ok: true, value: v };
}
