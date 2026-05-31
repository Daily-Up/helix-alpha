/**
 * query_asset_history tool.
 *
 * Given an asset symbol (BTC, MSTR, etc.), return what we've recently
 * said about it: signal direction history, hit rate so far, recent
 * conviction trajectory.
 *
 * Why the agent wants this:
 *   - Detects direction-lock conflicts: "we've fired 4 SHORTs on MSTR
 *     in the last 3 days; the new bullish news creates a direct
 *     contradiction."
 *   - Surfaces "we've been wrong about this asset lately" warnings the
 *     classifier doesn't have.
 *   - Gives the agent ammunition to downgrade conviction when the asset
 *     has been a recent loser.
 */

import { all } from "@/lib/db";
import type { AgentTool } from "./types";

interface Input {
  symbol: string;
  /** Days of history to pull. Default 14. */
  days?: number;
}

interface RecentSignal {
  signal_id: string;
  fired_at_iso: string;
  direction: "long" | "short";
  tier: "auto" | "review" | "info";
  confidence: number;
  status: string;
  outcome: string | null;
  realized_pct: number | null;
  triggering_event_title: string | null;
}

interface Output {
  symbol: string;
  asset_id: string | null;
  days: number;
  recent_signals: RecentSignal[];
  summary: {
    n_signals: number;
    n_long: number;
    n_short: number;
    n_target_hit: number;
    n_stop_hit: number;
    hit_rate: number | null;
    mean_realized_pct: number | null;
  };
}

export const assetHistoryTool: AgentTool<Input, Output> = {
  spec: {
    name: "query_asset_history",
    description:
      "Look up the recent signal history for an asset by symbol (e.g. " +
      "'BTC', 'MSTR', 'COIN'). Returns the last N days of signals on " +
      "this asset with their direction, tier, conviction, and resolved " +
      "outcome. Use this to detect direction conflicts (e.g. multiple " +
      "recent SHORTs on the same asset that contradict a new LONG) and " +
      "to discount conviction when recent signals have been wrong.",
    input_schema: {
      type: "object",
      required: ["symbol"],
      properties: {
        symbol: {
          type: "string",
          description: "Asset symbol (case-insensitive). Examples: BTC, MSTR, COIN.",
        },
        days: {
          type: "number",
          description: "Days of history. Default 14, max 90.",
        },
      },
    },
  },
  async handle(input) {
    const sym = input.symbol.trim().toUpperCase();
    const days = Math.min(90, Math.max(1, input.days ?? 14));
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

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
        days,
        recent_signals: [],
        summary: {
          n_signals: 0,
          n_long: 0,
          n_short: 0,
          n_target_hit: 0,
          n_stop_hit: 0,
          hit_rate: null,
          mean_realized_pct: null,
        },
      };
    }

    const rows = await all<{
      signal_id: string;
      fired_at: number;
      direction: "long" | "short";
      tier: "auto" | "review" | "info";
      confidence: number;
      status: string;
      outcome: string | null;
      realized_pct: number | null;
      title: string | null;
    }>(
      `SELECT s.id AS signal_id, s.fired_at, s.direction, s.tier,
              s.confidence, s.status,
              o.outcome, o.realized_pct,
              n.title AS title
       FROM signals s
       LEFT JOIN signal_outcomes o ON o.signal_id = s.id
       LEFT JOIN news_events n ON n.id = s.triggered_by_event_id
       WHERE s.asset_id = ?
         AND s.fired_at >= ?
       ORDER BY s.fired_at DESC
       LIMIT 50`,
      [asset.id, since],
    );

    let nLong = 0;
    let nShort = 0;
    let nTarget = 0;
    let nStop = 0;
    let realizedSum = 0;
    let realizedCount = 0;

    const recent_signals: RecentSignal[] = rows.map((r) => {
      if (r.direction === "long") nLong++;
      else nShort++;
      if (r.outcome === "target_hit") nTarget++;
      if (r.outcome === "stop_hit") nStop++;
      if (r.realized_pct != null) {
        realizedSum += r.realized_pct;
        realizedCount++;
      }
      return {
        signal_id: r.signal_id,
        fired_at_iso: new Date(r.fired_at).toISOString(),
        direction: r.direction,
        tier: r.tier,
        confidence: r.confidence,
        status: r.status,
        outcome: r.outcome,
        realized_pct: r.realized_pct,
        triggering_event_title: r.title,
      };
    });

    const resolved = nTarget + nStop;
    return {
      symbol: sym,
      asset_id: asset.id,
      days,
      recent_signals,
      summary: {
        n_signals: rows.length,
        n_long: nLong,
        n_short: nShort,
        n_target_hit: nTarget,
        n_stop_hit: nStop,
        hit_rate: resolved > 0 ? Math.round((nTarget / resolved) * 100) / 100 : null,
        mean_realized_pct:
          realizedCount > 0
            ? Math.round((realizedSum / realizedCount) * 100) / 100
            : null,
      },
    };
  },
};
