/**
 * query_similar_catalyst tool.
 *
 * Queries the 362-event hand-curated `historical_catalysts` table for
 * past events matching the given category (optionally filtered by asset
 * or regime context) and returns the distribution of realized moves
 * across multiple horizons.
 *
 * Why: it's one thing for the agent to say "this is a corporate treasury
 * buy". It's another to know "in 64 past corporate treasury buys, BTC's
 * median 7d move was +1.2%, hit rate above 0 was 58%, biggest winner was
 * +19.5% (Tesla 2021), biggest loser was -11.2%". The latter is what
 * makes the conviction calibrated.
 *
 * Data: `historical_catalysts`, populated by scripts/ingest-catalysts.mjs.
 */

import type { AgentTool } from "./types";
import { all } from "@/lib/db/client";

interface Input {
  category: string;        // exchange_hack | corporate_treasury_buy | etc.
  horizon?: "event_day" | "1d" | "3d" | "7d" | "30d";
  /** Filter to events where the indexed asset's move had a specific sign. */
  direction?: "any" | "positive" | "negative";
  /** Filter to events where BTC was in a specific regime at the time. */
  regime?: "any" | "up" | "down" | "sideways";
  /** Which asset's moves to report on. Defaults to BTC. */
  asset?: "BTC" | "ETH";
  limit?: number;
}

interface SampleEvent {
  date: string;
  description: string;
  btc_move: number | null;
  eth_move: number | null;
}

interface Output {
  category: string;
  horizon: string;
  sample_size: number;
  /** BTC distribution. */
  btc_mean_pct: number | null;
  btc_median_pct: number | null;
  btc_hit_rate_pos: number | null;     // share of events with btc_move > 0
  btc_min_pct: number | null;
  btc_max_pct: number | null;
  btc_stdev_pct: number | null;
  /** ETH distribution. */
  eth_mean_pct: number | null;
  eth_median_pct: number | null;
  eth_hit_rate_pos: number | null;
  /** Most extreme historical analogs (3 biggest moves, 3 smallest). */
  top_movers: SampleEvent[];
  bottom_movers: SampleEvent[];
  /** Plain-English roll-up for the agent's reasoning. */
  summary: string;
}

interface Row {
  date: string;
  description: string;
  btc_move: number | null;
  eth_move: number | null;
}

function pct(x: number): string {
  const sign = x > 0 ? "+" : "";
  return `${sign}${x.toFixed(2)}%`;
}

function pickColumn(horizon: string): { btcCol: string; ethCol: string } {
  switch (horizon) {
    case "event_day": return { btcCol: "btc_move_event_day", ethCol: "eth_move_event_day" };
    case "1d": return { btcCol: "btc_move_1d", ethCol: "eth_move_1d" };
    case "3d": return { btcCol: "btc_move_3d", ethCol: "eth_move_3d" };
    case "7d": return { btcCol: "btc_move_7d", ethCol: "eth_move_7d" };
    case "30d": return { btcCol: "btc_move_30d", ethCol: "eth_move_30d" };
    default: return { btcCol: "btc_move_7d", ethCol: "eth_move_7d" };
  }
}

export const querySimilarCatalystTool: AgentTool<Input, Output> = {
  spec: {
    name: "query_similar_catalyst",
    description:
      "Look up the historical distribution of BTC/ETH realized moves " +
      "following past events of a given category. Returns sample size, " +
      "mean, median, hit rate (% positive), stdev, range, and named " +
      "historical analogs (top + bottom 3 moves). 362 hand-curated events " +
      "going back to 2020. Use to calibrate conviction — if you're firing " +
      "a LONG on 'corporate_treasury_buy' but the historical 7d median is " +
      "+0.4% (n=64, hit rate 52%), an 'auto'-tier 75% conviction is " +
      "miscalibrated; downgrade to review.",
    input_schema: {
      type: "object",
      required: ["category"],
      properties: {
        category: {
          type: "string",
          description:
            "Catalyst category. Choices: macro_shock, " +
            "corporate_treasury_buy, exchange_hack, regulatory_action, " +
            "etf_filing_or_approval, exchange_collapse, " +
            "protocol_milestone, government_action, fork_or_upgrade, " +
            "stablecoin_depeg, court_ruling, halving, " +
            "prominent_endorsement, founder_arrest.",
        },
        horizon: {
          type: "string",
          enum: ["event_day", "1d", "3d", "7d", "30d"],
          description: "Which forward-return horizon to summarize. Defaults to 7d.",
        },
        direction: {
          type: "string",
          enum: ["any", "positive", "negative"],
          description:
            "Filter to only events where BTC moved in this direction. " +
            "Use 'any' (default) for the full distribution.",
        },
        regime: {
          type: "string",
          enum: ["any", "up", "down", "sideways"],
          description:
            "Filter to events that fired when BTC was in the given regime. " +
            "Use this to ask 'how did past corporate_treasury_buy events do " +
            "WHEN BTC was already in a downtrend?' — the answer is what " +
            "actually matters when assessing a current Saylor buy in a " +
            "down tape. Defaults to 'any' (no regime filter).",
        },
        asset: {
          type: "string",
          enum: ["BTC", "ETH"],
          description:
            "Which asset's realized moves to summarize. Defaults to BTC.",
        },
        limit: {
          type: "integer",
          description: "Max events to consider. Defaults to all.",
        },
      },
    },
  },
  async handle(input) {
    const horizon = input.horizon ?? "7d";
    const direction = input.direction ?? "any";
    const regime = input.regime ?? "any";
    const focusAsset = (input.asset ?? "BTC").toUpperCase();
    const { btcCol, ethCol } = pickColumn(horizon);
    // Pivot the direction filter to whichever asset is the focus.
    const focusCol = focusAsset === "ETH" ? ethCol : btcCol;

    let sql = `SELECT date, description,
                      ${btcCol} AS btc_move,
                      ${ethCol} AS eth_move
               FROM historical_catalysts
               WHERE category = ?
                 AND ${focusCol} IS NOT NULL`;
    const args: (string | number)[] = [input.category];
    if (direction === "positive") sql += ` AND ${focusCol} > 0`;
    if (direction === "negative") sql += ` AND ${focusCol} < 0`;
    if (regime !== "any") {
      sql += ` AND btc_regime = ?`;
      args.push(regime);
    }
    sql += " ORDER BY ts_ms ASC";
    if (input.limit && input.limit > 0) {
      sql += " LIMIT ?";
      args.push(input.limit);
    }

    const rows = await all<Row>(sql, args);
    const btcVals = rows.map((r) => r.btc_move).filter((x): x is number => x != null);
    const ethVals = rows.map((r) => r.eth_move).filter((x): x is number => x != null);

    if (btcVals.length === 0) {
      return {
        category: input.category,
        horizon,
        sample_size: 0,
        btc_mean_pct: null, btc_median_pct: null, btc_hit_rate_pos: null,
        btc_min_pct: null, btc_max_pct: null, btc_stdev_pct: null,
        eth_mean_pct: null, eth_median_pct: null, eth_hit_rate_pos: null,
        top_movers: [],
        bottom_movers: [],
        summary: `No historical events in category "${input.category}" matched the filters.`,
      };
    }

    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
    };
    const stdev = (xs: number[]) => {
      if (xs.length < 2) return 0;
      const m = mean(xs);
      return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1));
    };
    const hitRate = (xs: number[]) => xs.filter((x) => x > 0).length / xs.length;

    // Pivot stats and the sort to whichever asset is the focus.
    const focusVals = focusAsset === "ETH" ? ethVals : btcVals;
    const getFocus = (r: Row) => (focusAsset === "ETH" ? r.eth_move : r.btc_move);
    const sorted = [...rows]
      .filter((r) => getFocus(r) != null)
      .sort((a, b) => (getFocus(b) as number) - (getFocus(a) as number));
    const round = (n: number) => Math.round(n * 100) / 100;

    const fMean = round(mean(focusVals));
    const fMedian = round(median(focusVals));
    const fStdev = round(stdev(focusVals));
    const fHit = Math.round(hitRate(focusVals) * 100) / 100;
    const fMin = round(Math.min(...focusVals));
    const fMax = round(Math.max(...focusVals));
    // Keep BTC stats in the response too (the agent often wants both).
    const btcMean = round(mean(btcVals));
    const btcMedian = round(median(btcVals));
    const btcStdev = round(stdev(btcVals));
    const btcHit = Math.round(hitRate(btcVals) * 100) / 100;

    const filters: string[] = [];
    if (regime !== "any") filters.push(`BTC regime=${regime}`);
    if (direction !== "any") filters.push(`${focusAsset} move=${direction}`);
    const filterStr = filters.length > 0 ? ` [${filters.join(", ")}]` : "";
    const summary =
      `Category "${input.category}" @ ${horizon}${filterStr}: ` +
      `n=${focusVals.length}, ${focusAsset} mean ${pct(fMean)}, median ${pct(fMedian)}, ` +
      `hit-rate ${(fHit * 100).toFixed(0)}% positive, range [${pct(fMin)}, ${pct(fMax)}], ` +
      `stdev ${fStdev.toFixed(2)}%.`;

    return {
      category: input.category,
      horizon,
      sample_size: focusVals.length,
      btc_mean_pct: btcVals.length > 0 ? btcMean : null,
      btc_median_pct: btcVals.length > 0 ? btcMedian : null,
      btc_hit_rate_pos: btcVals.length > 0 ? btcHit : null,
      btc_min_pct: btcVals.length > 0 ? round(Math.min(...btcVals)) : null,
      btc_max_pct: btcVals.length > 0 ? round(Math.max(...btcVals)) : null,
      btc_stdev_pct: btcVals.length > 0 ? btcStdev : null,
      eth_mean_pct: ethVals.length > 0 ? round(mean(ethVals)) : null,
      eth_median_pct: ethVals.length > 0 ? round(median(ethVals)) : null,
      eth_hit_rate_pos: ethVals.length > 0 ? Math.round(hitRate(ethVals) * 100) / 100 : null,
      top_movers: sorted.slice(0, 3).map((r) => ({
        date: r.date,
        description: r.description,
        btc_move: r.btc_move,
        eth_move: r.eth_move,
      })),
      bottom_movers: sorted.slice(-3).reverse().map((r) => ({
        date: r.date,
        description: r.description,
        btc_move: r.btc_move,
        eth_move: r.eth_move,
      })),
      summary,
    };
  },
};
