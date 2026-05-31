/**
 * query_price_around_catalyst tool.
 *
 * Returns the price action of an asset in a window around a catalyst
 * timestamp: pre-catalyst close, post-catalyst closes at +1/+2/+3 days,
 * and the implied move.
 *
 * Why agent wants this:
 *   The price-already-moved check is a major bug class in news-driven
 *   trading: if BTC is already up 8% by the time the catalyst headline
 *   lands, fading the move is the right call — not chasing it. Letting
 *   the agent see the actual price tape around the catalyst is the
 *   single best defense.
 */

import { all } from "@/lib/db";
import type { AgentTool } from "./types";

interface Input {
  symbol: string;
  /** ISO timestamp OR ms epoch — the catalyst time. */
  catalyst_time: string | number;
  /** Days of price tape before/after to return. Default 3. */
  window_days?: number;
}

interface PricePoint {
  date: string;
  close: number;
  pct_vs_catalyst_close: number | null;
}

interface Output {
  symbol: string;
  asset_id: string | null;
  catalyst_iso: string;
  pre_catalyst_close: PricePoint | null;
  post_catalyst_series: PricePoint[];
  implied_move_1d_pct: number | null;
  implied_move_3d_pct: number | null;
  current_price: number | null;
  current_move_pct: number | null;
  interpretation: string;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export const queryPriceAroundCatalystTool: AgentTool<Input, Output> = {
  spec: {
    name: "query_price_around_catalyst",
    description:
      "Return the daily price tape of an asset in a window around a " +
      "catalyst timestamp. Crucial for the 'price already moved' check: " +
      "if the asset rallied 8% intraday before the news hit, chasing the " +
      "move is wrong. Use BEFORE finalising direction/conviction.",
    input_schema: {
      type: "object",
      required: ["symbol", "catalyst_time"],
      properties: {
        symbol: {
          type: "string",
          description: "Asset symbol (e.g. BTC, MSTR, COIN).",
        },
        catalyst_time: {
          type: "string",
          description:
            "Catalyst timestamp. Pass either an ISO string " +
            "('2026-05-31T14:00:00Z') or ms-epoch number.",
        },
        window_days: {
          type: "number",
          description: "Days before/after catalyst. Default 3, max 10.",
        },
      },
    },
  },
  async handle(input) {
    const sym = input.symbol.trim().toUpperCase();
    const ts =
      typeof input.catalyst_time === "number"
        ? input.catalyst_time
        : Date.parse(input.catalyst_time);
    if (!Number.isFinite(ts)) {
      throw new Error(`bad catalyst_time: ${input.catalyst_time}`);
    }
    const days = Math.min(10, Math.max(1, input.window_days ?? 3));
    const DAY = 24 * 60 * 60 * 1000;

    const asset = (
      await all<{ id: string }>(
        `SELECT id FROM assets WHERE upper(symbol) = ? LIMIT 1`,
        [sym],
      )
    )[0];
    if (!asset) {
      return {
        symbol: sym,
        asset_id: null,
        catalyst_iso: new Date(ts).toISOString(),
        pre_catalyst_close: null,
        post_catalyst_series: [],
        implied_move_1d_pct: null,
        implied_move_3d_pct: null,
        current_price: null,
        current_move_pct: null,
        interpretation:
          `Asset ${sym} not in tracked universe — no kline coverage. ` +
          `Cannot evaluate price-already-moved.`,
      };
    }

    const fromDate = formatDate(ts - days * DAY);
    const toDate = formatDate(ts + days * DAY);

    const rows = await all<{ date: string; close: number }>(
      `SELECT date, close FROM klines_daily
       WHERE asset_id = ?
         AND date >= ? AND date <= ?
       ORDER BY date ASC`,
      [asset.id, fromDate, toDate],
    );

    const catalystDate = formatDate(ts);
    // Pre-catalyst close: last close on or before catalyst date.
    const preIdx = rows.findIndex((r) => r.date > catalystDate);
    const preRow = preIdx === -1 ? rows[rows.length - 1] : rows[preIdx - 1];
    const preCatalyst: PricePoint | null = preRow
      ? {
          date: preRow.date,
          close: preRow.close,
          pct_vs_catalyst_close: 0,
        }
      : null;

    const postRows = preIdx === -1 ? [] : rows.slice(preIdx);
    const post: PricePoint[] = postRows.map((r) => ({
      date: r.date,
      close: r.close,
      pct_vs_catalyst_close:
        preRow && preRow.close > 0
          ? Math.round(((r.close - preRow.close) / preRow.close) * 10000) / 100
          : null,
    }));

    const implied1d =
      post.length >= 1 ? post[0]?.pct_vs_catalyst_close ?? null : null;
    const implied3d =
      post.length >= 3 ? post[2]?.pct_vs_catalyst_close ?? null : null;

    // Most recent close anywhere in the asset's series — for "current"
    // mark.
    const currentRow = (
      await all<{ date: string; close: number }>(
        `SELECT date, close FROM klines_daily
         WHERE asset_id = ? ORDER BY date DESC LIMIT 1`,
        [asset.id],
      )
    )[0];
    const current_price = currentRow?.close ?? null;
    const current_move_pct =
      preRow && current_price != null && preRow.close > 0
        ? Math.round(
            ((current_price - preRow.close) / preRow.close) * 10000,
          ) / 100
        : null;

    let interpretation: string;
    if (!preRow) {
      interpretation = `No pre-catalyst close on file (asset newly listed or kline gap).`;
    } else if (implied1d != null && Math.abs(implied1d) > 8) {
      interpretation = `Already moved ${implied1d > 0 ? "up" : "down"} ${Math.abs(implied1d)}% one day after the catalyst — much of the directional response is already in. Chasing is risky.`;
    } else if (current_move_pct != null && Math.abs(current_move_pct) > 6) {
      interpretation = `Asset is currently ${current_move_pct > 0 ? "up" : "down"} ${Math.abs(current_move_pct)}% from catalyst close. Substantial move already realised.`;
    } else {
      interpretation = `Move so far is modest (${implied1d ?? "?"}% 1d, current ${current_move_pct ?? "?"}%). Room left for the catalyst to play out.`;
    }

    return {
      symbol: sym,
      asset_id: asset.id,
      catalyst_iso: new Date(ts).toISOString(),
      pre_catalyst_close: preCatalyst,
      post_catalyst_series: post,
      implied_move_1d_pct: implied1d,
      implied_move_3d_pct: implied3d,
      current_price,
      current_move_pct,
      interpretation,
    };
  },
};
