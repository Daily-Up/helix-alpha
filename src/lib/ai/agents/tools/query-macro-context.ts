/**
 * query_macro_context tool.
 *
 * Two modes via the `mode` parameter:
 *
 *   `nearest`  — "what macro release happened ON or NEAR this date,
 *                 what was the surprise vs prior, and how did
 *                 SPX/DXY/10Y/BTC react?" Returns a single row.
 *
 *   `cohort`   — "for past events of this type WITH a surprise of this
 *                 sign, what does the BTC reaction distribution look
 *                 like?" Returns aggregate stats over many events.
 *
 * Why both: the agent often wants either the immediate context
 * ("this BTC dump is happening on a hot CPI print") or the base rate
 * ("how often does BTC bottom within 24h of a hot CPI?").
 *
 * Data: `macro_calibration`, populated by scripts/build-macro-context.mjs.
 */

import type { AgentTool } from "./types";
import { all, get } from "@/lib/db/client";

interface Input {
  mode: "nearest" | "cohort";
  /** For `nearest`: anchor date (YYYY-MM-DD or ISO). */
  date?: string;
  /** For `cohort`: which event type to aggregate over. */
  event_type?:
    | "FOMC_decision" | "CPI" | "Core_CPI" | "PCE" | "Core_PCE"
    | "NFP" | "Unemployment" | "special";
  /** For `cohort`: filter to surprises of a given sign. */
  surprise_sign?: "any" | "positive" | "negative";
}

interface NearestRow {
  date: string;
  event_type: string;
  description: string;
  actual: number | null;
  previous: number | null;
  surprise_proxy: number | null;
  spx_move_1d_pct: number | null;
  dxy_move_1d_pct: number | null;
  ten_year_move_bp: number | null;
  btc_move_1h_pct: number | null;
  btc_move_1d_pct: number | null;
  btc_move_3d_pct: number | null;
  btc_move_7d_pct: number | null;
  eth_move_1d_pct: number | null;
}

interface Output {
  mode: string;
  // nearest mode
  found?: boolean;
  event?: NearestRow | null;
  summary: string;
  // cohort mode
  sample_size?: number;
  btc_1h_mean_pct?: number | null;
  btc_1h_median_pct?: number | null;
  btc_1d_mean_pct?: number | null;
  btc_1d_median_pct?: number | null;
  btc_1d_hit_rate?: number | null;
  btc_7d_median_pct?: number | null;
}

export const queryMacroContextTool: AgentTool<Input, Output> = {
  spec: {
    name: "query_macro_context",
    description:
      "Look up the macro-release context around a date or aggregate the " +
      "BTC reaction to past events of a given type and surprise direction. " +
      "Use `mode=nearest` with `date` to ask 'is today an FOMC day / what " +
      "was CPI's surprise?' Use `mode=cohort` with `event_type` to ask " +
      "'what's the typical BTC 1d reaction to hot CPI prints'.",
    input_schema: {
      type: "object",
      required: ["mode"],
      properties: {
        mode: {
          type: "string",
          enum: ["nearest", "cohort"],
          description:
            "nearest: single closest macro release to a given date. " +
            "cohort: aggregate stats across all events of an event_type.",
        },
        date: {
          type: "string",
          description:
            "Anchor date for `nearest` mode (YYYY-MM-DD). Window is ±2 days.",
        },
        event_type: {
          type: "string",
          enum: [
            "FOMC_decision","CPI","Core_CPI","PCE","Core_PCE","NFP","Unemployment","special",
          ],
          description: "Required for `cohort` mode.",
        },
        surprise_sign: {
          type: "string",
          enum: ["any", "positive", "negative"],
          description:
            "For `cohort` mode: filter to releases where actual > previous " +
            "(positive) or actual < previous (negative). Positive CPI " +
            "surprise = hotter than prior month, generally bearish for BTC. " +
            "Defaults to 'any'.",
        },
      },
    },
  },
  async handle(input) {
    if (input.mode === "nearest") {
      if (!input.date) {
        return {
          mode: "nearest",
          found: false,
          event: null,
          summary: "nearest mode requires a `date` parameter.",
        };
      }
      const dateOnly = input.date.slice(0, 10);
      const row = await get<NearestRow>(
        `SELECT date, event_type, description, actual, previous, surprise_proxy,
                spx_move_1d_pct, dxy_move_1d_pct, ten_year_move_bp,
                btc_move_1h_pct, btc_move_1d_pct, btc_move_3d_pct, btc_move_7d_pct,
                eth_move_1d_pct
         FROM macro_calibration
         WHERE date BETWEEN date(?, '-2 days') AND date(?, '+2 days')
         ORDER BY ABS(julianday(date) - julianday(?))
         LIMIT 1`,
        [dateOnly, dateOnly, dateOnly],
      );
      if (!row) {
        return {
          mode: "nearest",
          found: false,
          event: null,
          summary: `No macro event within ±2 days of ${dateOnly}. Effectively a 'quiet' macro day.`,
        };
      }
      const fmt = (n: number | null, suf = "%") =>
        n == null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}${suf}`;
      const sur =
        row.surprise_proxy == null
          ? "n/a"
          : `${row.surprise_proxy >= 0 ? "+" : ""}${row.surprise_proxy.toFixed(2)} vs prior`;
      const summary =
        `${row.date} ${row.event_type}: ${row.description}. ` +
        `Actual=${row.actual ?? "n/a"} (prior=${row.previous ?? "n/a"}, surprise=${sur}). ` +
        `SPX ${fmt(row.spx_move_1d_pct)}, DXY ${fmt(row.dxy_move_1d_pct)}, ` +
        `10Y ${fmt(row.ten_year_move_bp, "bp")}. ` +
        `BTC: 1h ${fmt(row.btc_move_1h_pct)}, 1d ${fmt(row.btc_move_1d_pct)}, 7d ${fmt(row.btc_move_7d_pct)}.`;
      return { mode: "nearest", found: true, event: row, summary };
    }

    // cohort mode
    if (!input.event_type) {
      return {
        mode: "cohort",
        summary: "cohort mode requires an `event_type` parameter.",
        sample_size: 0,
      };
    }
    const sign = input.surprise_sign ?? "any";
    let where = "event_type = ? AND btc_move_1d_pct IS NOT NULL";
    const args: (string | number)[] = [input.event_type];
    if (sign === "positive") where += " AND surprise_proxy > 0";
    if (sign === "negative") where += " AND surprise_proxy < 0";

    const rows = await all<{
      btc_1h: number | null;
      btc_1d: number;
      btc_7d: number | null;
    }>(
      `SELECT btc_move_1h_pct AS btc_1h, btc_move_1d_pct AS btc_1d,
              btc_move_7d_pct AS btc_7d
       FROM macro_calibration WHERE ${where}`,
      args,
    );
    if (rows.length === 0) {
      return {
        mode: "cohort",
        sample_size: 0,
        summary: `No matching events for event_type=${input.event_type}, surprise=${sign}.`,
      };
    }
    const v1h = rows.map((r) => r.btc_1h).filter((x): x is number => x != null);
    const v1d = rows.map((r) => r.btc_1d);
    const v7d = rows.map((r) => r.btc_7d).filter((x): x is number => x != null);
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length === 0
        ? null
        : s.length % 2 === 0
          ? (s[m - 1] + s[m]) / 2
          : s[m];
    };
    const mean = (xs: number[]) =>
      xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
    const round = (n: number | null) =>
      n == null ? null : Math.round(n * 100) / 100;
    const hit1d = v1d.filter((x) => x > 0).length / v1d.length;
    const btc1hMean = round(mean(v1h));
    const btc1hMedian = round(median(v1h));
    const btc1dMean = round(mean(v1d));
    const btc1dMedian = round(median(v1d));
    const btc7dMedian = round(median(v7d));
    const summary =
      `n=${rows.length} past ${input.event_type} events with surprise=${sign}: ` +
      `BTC 1h median ${btc1hMedian ?? "n/a"}%, ` +
      `BTC 1d median ${btc1dMedian ?? "n/a"}% (${Math.round(hit1d * 100)}% positive), ` +
      `BTC 7d median ${btc7dMedian ?? "n/a"}%.`;
    return {
      mode: "cohort",
      sample_size: rows.length,
      btc_1h_mean_pct: btc1hMean,
      btc_1h_median_pct: btc1hMedian,
      btc_1d_mean_pct: btc1dMean,
      btc_1d_median_pct: btc1dMedian,
      btc_1d_hit_rate: Math.round(hit1d * 100) / 100,
      btc_7d_median_pct: btc7dMedian,
      summary,
    };
  },
};
