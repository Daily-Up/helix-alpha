/**
 * Claude review of a candidate portfolio.
 *
 * Takes the rule-derived target weights + per-asset rationale and asks
 * Claude to:
 *   1. Sanity-check the allocation (any obvious mistake?)
 *   2. Optionally adjust weights within constraints
 *   3. Write a concise reasoning paragraph that surfaces in the UI
 *
 * Falls back gracefully (returns rule weights + a templated reasoning) if
 * the AI call fails. Never blocks a rebalance on Claude availability.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { anthropic, getModel } from "@/lib/ai/client";
import { Assets, Settings } from "@/lib/db";
import type { CandidatePortfolio } from "./types";

const ReviewSchema = z.object({
  approved: z.boolean(),
  /** Optional adjusted weights {asset_id: 0..1}; if missing, use as-is. */
  adjusted_weights: z.record(z.string(), z.number()).optional(),
  reasoning: z.string().min(1),
});

export interface ReviewResult {
  weights: Record<string, number>;
  cash_weight: number;
  reasoning: string;
  reviewer_model: string;
  approved: boolean;
}

const reviewTool: Anthropic.Tool = {
  name: "review_index_rebalance",
  description:
    "Sanity-check a candidate AlphaIndex rebalance. May approve as-is or " +
    "suggest small weight adjustments. Always returns a concise reasoning " +
    "paragraph for the UI.",
  input_schema: {
    type: "object",
    required: ["approved", "reasoning"],
    properties: {
      approved: {
        type: "boolean",
        description:
          "TRUE if you accept the candidate weights without changes. FALSE if you adjust.",
      },
      adjusted_weights: {
        type: "object",
        description:
          "Optional. Map of asset_id → weight (0..1). Include ONLY when " +
          "you want to change weights. Sum of values must be ≤ 0.95 (leaving " +
          "room for cash reserve). Use the EXACT asset_ids shown in the " +
          "candidate (e.g. tok-btc, idx-ssimag7).",
        additionalProperties: { type: "number" },
      },
      reasoning: {
        type: "string",
        description:
          "1-3 sentences explaining the rebalance from a portfolio manager's " +
          "perspective. Reference the strongest signal drivers. This is the " +
          "public-facing rationale shown in the UI.",
      },
    },
  },
};

function buildPrompt(candidate: CandidatePortfolio): string {
  // Sort weights desc for readability.
  const lines = Object.entries(candidate.weights)
    .sort((a, b) => b[1] - a[1])
    .map(([id, w]) => {
      const asset = Assets.getAssetById(id);
      const sym = asset?.symbol ?? id;
      const score = candidate.scores.find((s) => s.asset.id === id);
      const drivers = score?.drivers.join("; ") ?? "anchor allocation";
      return `  ${id} (${sym}): ${(w * 100).toFixed(2)}%  ← ${drivers}`;
    })
    .join("\n");

  return (
    `Candidate AlphaIndex rebalance. Please sanity-check.\n\n` +
    `Cash reserve: ${(candidate.cash_weight * 100).toFixed(1)}%\n\n` +
    `Proposed weights:\n${lines}\n\n` +
    `Diagnostics: ${candidate.meta.candidates_considered} candidates considered, ` +
    `${candidate.meta.above_min_threshold} cleared the min-position threshold, ` +
    `${candidate.meta.capped_at_max} were capped at max-position.\n\n` +
    `Call review_index_rebalance now. Keep adjustments minor — the rule engine ` +
    `already did the heavy lifting. Focus the reasoning on the 2-3 biggest weight ` +
    `changes and what's driving them.`
  );
}

export async function reviewCandidate(
  candidate: CandidatePortfolio,
): Promise<ReviewResult> {
  const settings = Settings.getSettings();
  const model = getModel();

  // If user disabled Claude review, return the rule output with templated reasoning.
  if (!settings.index_review_with_claude) {
    return {
      weights: candidate.weights,
      cash_weight: candidate.cash_weight,
      reasoning: templateReasoning(candidate),
      reviewer_model: "rules-only",
      approved: true,
    };
  }

  try {
    const res = await anthropic().messages.create({
      model,
      max_tokens: 1024,
      tools: [reviewTool],
      tool_choice: { type: "tool", name: "review_index_rebalance" },
      messages: [{ role: "user", content: buildPrompt(candidate) }],
    });

    const toolUse = res.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );
    if (!toolUse) throw new Error("Claude returned no tool_use block");

    const parsed = ReviewSchema.parse(toolUse.input);

    let finalWeights = candidate.weights;
    let finalCash = candidate.cash_weight;

    if (parsed.adjusted_weights && !parsed.approved) {
      // Sanity: make sure the sum is reasonable, renormalise to leave room
      // for cash reserve.
      const adj = parsed.adjusted_weights;
      const validIds = Object.keys(adj).filter(
        (id) => Assets.getAssetById(id)?.tradable,
      );
      const cleaned: Record<string, number> = {};
      let sum = 0;
      for (const id of validIds) {
        const w = Math.max(0, Math.min(adj[id], 1));
        if (w > 0) {
          cleaned[id] = w;
          sum += w;
        }
      }
      if (sum > 0) {
        const targetPortfolio = 1 - candidate.cash_weight;
        const scale = targetPortfolio / sum;
        for (const id of Object.keys(cleaned)) cleaned[id] *= scale;
        finalWeights = cleaned;
        finalCash = candidate.cash_weight;
      }
    }

    return {
      weights: finalWeights,
      cash_weight: finalCash,
      reasoning: parsed.reasoning,
      reviewer_model: model,
      approved: parsed.approved,
    };
  } catch (err) {
    // Fail open — never block a rebalance on Claude.
    return {
      weights: candidate.weights,
      cash_weight: candidate.cash_weight,
      reasoning:
        templateReasoning(candidate) +
        ` [Claude review failed: ${(err as Error).message.slice(0, 80)}]`,
      reviewer_model: "rules-only",
      approved: true,
    };
  }
}

/** Fallback templated reasoning when Claude isn't used or fails. */
function templateReasoning(candidate: CandidatePortfolio): string {
  if (candidate.scores.length === 0) {
    return (
      "No positive signals in lookback window. Holding a balanced anchor " +
      "portfolio (BTC, ETH, SOL, MAG7.ssi, XAUT) until signals develop."
    );
  }
  const top = candidate.scores.slice(0, 3);
  const drivers = top
    .map(
      (s) =>
        `${s.asset.symbol} (${s.drivers.slice(0, 2).join(", ") || "broad strength"})`,
    )
    .join(", ");
  return `Allocation favours ${drivers}. ${candidate.meta.above_min_threshold} positions sized above minimum threshold; cash reserve held for liquidity.`;
}
