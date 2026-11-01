/**
 * Prompt + structured-output schema for the on-demand "Setup" — Helix's
 * answer to TrueNorth's /setup. Given one asset plus its recent SoSoValue
 * news and price context, Claude returns a grounded trade setup: a
 * directional bias, conviction, reasoning, key levels, and an
 * entry/target/stop plan. Every claim must trace back to the supplied
 * news/price data — this is the auditable edge over a generic TA bot.
 */

import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";

export const SETUP_PROMPT_VERSION = "setup-v1";

/** Structured setup Claude must return via the forced tool call. */
export const SetupSchema = z.object({
  bias: z.enum(["bullish", "bearish", "neutral"]),
  direction: z.enum(["long", "short", "none"]),
  /** 0–100 — how strong the case is given the evidence. */
  conviction: z.number().min(0).max(100),
  /** e.g. "intraday", "1–3 days", "1–2 weeks". */
  horizon: z.string(),
  /** One line, leads with the call. e.g. "LONG mean-reversion into the day open." */
  tldr: z.string(),
  /** 2–4 sentences, each grounded in the supplied news or price data. */
  reasoning: z.string(),
  /** Support/resistance levels with the reason each matters. */
  key_levels: z
    .array(
      z.object({
        kind: z.enum(["support", "resistance"]),
        price: z.number(),
        label: z.string(),
      }),
    )
    .max(6),
  /** Trade plan — null fields when a directionless/neutral read. */
  entry: z.number().nullable(),
  target: z.number().nullable(),
  stop: z.number().nullable(),
  /** The concrete catalysts driving the call, in plain words. */
  catalysts: z.array(z.string()).max(6),
});

export type Setup = z.infer<typeof SetupSchema>;

/** Anthropic tool definition mirroring SetupSchema. */
export function setupTool(): Anthropic.Messages.Tool {
  return {
    name: "publish_setup",
    description:
      "Return a structured, evidence-grounded trade setup for the asset.",
    input_schema: {
      type: "object",
      properties: {
        bias: {
          type: "string",
          enum: ["bullish", "bearish", "neutral"],
          description: "Net directional lean from the news + price evidence.",
        },
        direction: {
          type: "string",
          enum: ["long", "short", "none"],
          description: "The tradable side. 'none' when neutral / no edge.",
        },
        conviction: {
          type: "number",
          description:
            "0–100 strength of the case. Low when evidence is thin, mixed, or stale.",
        },
        horizon: {
          type: "string",
          description: "Time frame the setup is valid for, e.g. '1–3 days'.",
        },
        tldr: {
          type: "string",
          description:
            "One line that leads with the call, e.g. 'LONG into day-open support'.",
        },
        reasoning: {
          type: "string",
          description:
            "2–4 sentences. Every claim must tie to a supplied headline or the price context. No invented facts.",
        },
        key_levels: {
          type: "array",
          maxItems: 6,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["support", "resistance"] },
              price: { type: "number" },
              label: {
                type: "string",
                description: "Why the level matters, e.g. '7d low', '24h high'.",
              },
            },
            required: ["kind", "price", "label"],
          },
          description:
            "Support/resistance anchored to the supplied price stats (recent highs/lows, current price).",
        },
        entry: {
          type: ["number", "null"],
          description: "Suggested entry price, or null for a neutral read.",
        },
        target: { type: ["number", "null"], description: "Profit target, or null." },
        stop: { type: ["number", "null"], description: "Protective stop, or null." },
        catalysts: {
          type: "array",
          maxItems: 6,
          items: { type: "string" },
          description: "The concrete news drivers behind the call, in plain words.",
        },
      },
      required: [
        "bias",
        "direction",
        "conviction",
        "horizon",
        "tldr",
        "reasoning",
        "key_levels",
        "entry",
        "target",
        "stop",
        "catalysts",
      ],
    },
  };
}

export function setupSystemPrompt(): string {
  return [
    "You are Helix's trade-setup analyst. You turn an asset's recent news and price action into ONE clear, honest trade setup.",
    "",
    "Rules:",
    "- Ground every claim in the data you are given — the supplied headlines (with sentiment/event-type) and the price stats. Never invent prices, levels, or events.",
    "- Anchor key_levels and entry/target/stop to the supplied price stats (current price, recent highs/lows). Keep them on the right side of price for the chosen direction.",
    "- If the news is thin, mixed, or stale, say so and return a NEUTRAL bias with low conviction and null trade levels. A non-call is a valid, valuable answer.",
    "- Bias reflects the net of news sentiment AND price trend. Direction is the tradable side ('none' when neutral).",
    "- Be concise and specific. No hedging filler, no financial-advice disclaimers.",
    "Return your answer only through the publish_setup tool.",
  ].join("\n");
}
