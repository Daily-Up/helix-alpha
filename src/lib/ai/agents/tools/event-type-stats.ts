/**
 * query_event_type_stats tool.
 *
 * Given an event_type (e.g. "treasury", "etf_flow", "regulatory"),
 * return the empirical hit rate and mean realized PnL of signals on
 * that event_type from our own measured backtest data.
 *
 * Why the agent wants this:
 *   - Calibration: "the model is excited about a treasury catalyst,
 *     but treasury signals have only hit target 28% of the time in
 *     our data — be more conservative on conviction."
 *   - Or the opposite: "exploit signals have a 71% hit rate at 3d —
 *     this one deserves AUTO tier."
 */

import { all } from "@/lib/db";
import type { AgentTool } from "./types";

interface Input {
  event_type: string;
  sentiment?: "positive" | "negative" | "neutral";
  days?: number;
}

interface Output {
  event_type: string;
  sentiment: string | null;
  window_days: number;
  sample_size: number;
  hit_rate_3d: number | null;
  mean_realized_pct_3d: number | null;
  mean_realized_pct_1d: number | null;
  notes: string;
}

export const eventTypeStatsTool: AgentTool<Input, Output> = {
  spec: {
    name: "query_event_type_stats",
    description:
      "Return the empirical hit rate and mean realized PnL of signals " +
      "on a given event_type (e.g. 'treasury', 'etf_flow', 'regulatory', " +
      "'exploit', 'partnership', 'listing', 'earnings'). Use this to " +
      "calibrate conviction against measured outcomes — if our data " +
      "shows this catalyst category has historically underperformed, " +
      "downgrade. If it's a high-hit-rate category, upgrade.",
    input_schema: {
      type: "object",
      required: ["event_type"],
      properties: {
        event_type: {
          type: "string",
          description:
            "Classifier event_type. Valid values: exploit, regulatory, " +
            "etf_flow, partnership, listing, social_platform, unlock, " +
            "airdrop, earnings, macro, treasury, governance, tech_update, " +
            "security, narrative, fundraising, other.",
        },
        sentiment: {
          type: "string",
          enum: ["positive", "negative", "neutral"],
          description: "Optional sentiment filter.",
        },
        days: {
          type: "number",
          description: "Days of history. Default 90.",
        },
      },
    },
  },
  async handle(input) {
    const days = Math.min(365, Math.max(7, input.days ?? 90));
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const sentClause = input.sentiment ? "AND c.sentiment = ?" : "";
    const params: (string | number)[] = [input.event_type, since];
    if (input.sentiment) params.push(input.sentiment);

    const rows = await all<{
      impact_1d: number | null;
      impact_3d: number | null;
    }>(
      `SELECT im.impact_pct_1d AS impact_1d,
              im.impact_pct_3d AS impact_3d
       FROM impact_metrics im
       JOIN classifications c ON c.event_id = im.event_id
       JOIN news_events n ON n.id = im.event_id
       WHERE c.event_type = ?
         AND n.release_time >= ?
         ${sentClause}`,
      params,
    );

    const sample = rows.length;
    if (sample === 0) {
      return {
        event_type: input.event_type,
        sentiment: input.sentiment ?? null,
        window_days: days,
        sample_size: 0,
        hit_rate_3d: null,
        mean_realized_pct_3d: null,
        mean_realized_pct_1d: null,
        notes:
          "no measured outcomes in window — base rates unknown; treat " +
          "with caution",
      };
    }

    const expectedSign =
      input.sentiment === "positive"
        ? 1
        : input.sentiment === "negative"
          ? -1
          : 0;
    let hits3d = 0;
    let measured3d = 0;
    let sum3d = 0;
    let sum1d = 0;
    let n3d = 0;
    let n1d = 0;
    for (const r of rows) {
      if (r.impact_3d != null) {
        measured3d++;
        sum3d += r.impact_3d;
        n3d++;
        const aligned =
          expectedSign === 0
            ? r.impact_3d > 0
            : Math.sign(r.impact_3d) === expectedSign;
        if (aligned) hits3d++;
      }
      if (r.impact_1d != null) {
        sum1d += r.impact_1d;
        n1d++;
      }
    }

    return {
      event_type: input.event_type,
      sentiment: input.sentiment ?? null,
      window_days: days,
      sample_size: sample,
      hit_rate_3d:
        measured3d > 0 ? Math.round((hits3d / measured3d) * 1000) / 1000 : null,
      mean_realized_pct_3d:
        n3d > 0 ? Math.round((sum3d / n3d) * 100) / 100 : null,
      mean_realized_pct_1d:
        n1d > 0 ? Math.round((sum1d / n1d) * 100) / 100 : null,
      notes:
        sample < 5
          ? "small sample — treat directionally only"
          : "ok to weight in conviction",
    };
  },
};
