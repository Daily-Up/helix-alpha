/**
 * query_market_regime tool.
 *
 * Returns a compact regime snapshot — trend, drawdown, vol, RSI, days
 * since ATH — for the given asset at the given moment (default: now).
 *
 * The agent uses this to short-circuit "long BTC even though it's
 * clearly dumping" failures: when trend=down and drawdown < -8%, the
 * reasoning should reflect counter-trend risk, and a borderline LONG
 * conviction should be downgraded rather than auto-fired.
 *
 * Data: `historical_klines_hourly`, populated by
 * scripts/ingest-binance-history.mjs. Covers BTC + ETH back to 2017-08
 * and SOL back to 2020-08 at 1h granularity.
 */

import type { AgentTool } from "./types";
import { getRegime } from "@/lib/regime/classifier";

interface Input {
  symbol?: string;     // "BTC" | "ETH" | "SOL"  (default: BTC)
  datetime?: string;   // ISO 8601 (default: now)
}

interface Output {
  symbol: string;
  found: boolean;
  ts_iso: string | null;
  close: number | null;
  trend: "up" | "down" | "sideways" | null;
  drawdown_pct: number | null;
  vol_pct: number | null;
  rsi_14: number | null;
  days_since_ath: number | null;
  return_30d_pct: number | null;
  return_90d_pct: number | null;
  /** Human-readable summary the agent can paste into its reasoning. */
  summary: string;
}

export const queryMarketRegimeTool: AgentTool<Input, Output> = {
  spec: {
    name: "query_market_regime",
    description:
      "Get the market regime snapshot for an asset at a given moment. " +
      "Returns trend (up/down/sideways), drawdown from recent ATH, " +
      "annualized 30d volatility, RSI(14), days since ATH, and 30d/90d " +
      "returns. Use this BEFORE setting conviction on directional " +
      "signals — a LONG into trend=down with drawdown < -8% is " +
      "structurally risky regardless of the catalyst quality. Default " +
      "asks about BTC right now.",
    input_schema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "BTC | ETH | SOL. Defaults to BTC.",
          enum: ["BTC", "ETH", "SOL"],
        },
        datetime: {
          type: "string",
          description:
            "ISO 8601 timestamp for the moment to evaluate. Omit for current time.",
        },
      },
    },
  },
  async handle(input) {
    const symbol = (input.symbol ?? "BTC").toUpperCase();
    const ts_ms = input.datetime ? Date.parse(input.datetime) : Date.now();
    if (Number.isNaN(ts_ms)) {
      return {
        symbol,
        found: false,
        ts_iso: null,
        close: null,
        trend: null,
        drawdown_pct: null,
        vol_pct: null,
        rsi_14: null,
        days_since_ath: null,
        return_30d_pct: null,
        return_90d_pct: null,
        summary: `Bad datetime: ${input.datetime}`,
      };
    }

    const r = await getRegime(symbol, ts_ms);
    if (!r) {
      return {
        symbol,
        found: false,
        ts_iso: null,
        close: null,
        trend: null,
        drawdown_pct: null,
        vol_pct: null,
        rsi_14: null,
        days_since_ath: null,
        return_30d_pct: null,
        return_90d_pct: null,
        summary: `No regime data for ${symbol} at ${new Date(ts_ms).toISOString()}.`,
      };
    }

    const summary =
      `${symbol} ${r.trend.toUpperCase()} regime — ` +
      `close $${r.close.toLocaleString()}, ` +
      `${r.drawdown_pct.toFixed(1)}% from ATH (${r.days_since_ath}d ago), ` +
      `RSI(14)=${r.rsi_14.toFixed(0)}, ` +
      `30d return ${r.return_30d_pct == null ? "n/a" : r.return_30d_pct.toFixed(1) + "%"}, ` +
      `realized vol ${r.vol_pct.toFixed(0)}%.`;

    return {
      symbol: r.symbol,
      found: true,
      ts_iso: new Date(r.ts_ms).toISOString(),
      close: r.close,
      trend: r.trend,
      drawdown_pct: r.drawdown_pct,
      vol_pct: r.vol_pct,
      rsi_14: r.rsi_14,
      days_since_ath: r.days_since_ath,
      return_30d_pct: r.return_30d_pct,
      return_90d_pct: r.return_90d_pct,
      summary,
    };
  },
};
