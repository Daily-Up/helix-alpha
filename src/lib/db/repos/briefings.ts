/**
 * Repository — `briefings`. Wave 2: async.
 */

import { all, get, run } from "../client";

export interface TopPick {
  asset_id: string;
  asset_symbol: string;
  direction: "long" | "short" | "watch";
  thesis: string;
  conviction: number;
}

export interface WatchlistEntry {
  asset_id: string;
  symbol: string;
  note: string;
}

export type Regime = "risk_on" | "risk_off" | "mixed" | "neutral";

export interface BriefingRow {
  date: string;
  generated_at: number;
  headline: string;
  regime: Regime;
  body: string;
  top_pick: TopPick | null;
  watchlist: WatchlistEntry[];
  inputs_summary: BriefingInputsSummary;
  model: string;
  prompt_version: string;
  tokens_input: number;
  tokens_output: number;
  tokens_cached: number;
  cost_usd: number;
}

export interface BriefingInputsSummary {
  pending_signals: number;
  classifications_24h: number;
  top_event_types: Array<{ event_type: string; n: number }>;
  alphaindex_top_positions: Array<{ symbol: string; weight_pct: number }>;
  sector_top: Array<{ name: string; change_24h_pct: number }>;
  sector_bottom: Array<{ name: string; change_24h_pct: number }>;
  etf_net_flow_24h_usd: number | null;
  best_event_type_hit_rate: { event_type: string; hit_rate_3d: number | null; n: number } | null;
  treasury_summary: {
    acquiring_companies: number;
    net_btc_acquired: number;
    total_acq_cost_usd: number | null;
    total_btc_held_latest: number;
  } | null;
}

interface RawBriefingRow {
  date: string;
  generated_at: number;
  headline: string;
  regime: string;
  body: string;
  top_pick: string | null;
  watchlist: string | null;
  inputs_summary: string;
  model: string;
  prompt_version: string;
  tokens_input: number;
  tokens_output: number;
  tokens_cached: number;
  cost_usd: number;
}

function rowToBriefing(r: RawBriefingRow): BriefingRow {
  return {
    date: r.date,
    generated_at: r.generated_at,
    headline: r.headline,
    regime: r.regime as Regime,
    body: r.body,
    top_pick: r.top_pick ? (JSON.parse(r.top_pick) as TopPick) : null,
    watchlist: r.watchlist ? (JSON.parse(r.watchlist) as WatchlistEntry[]) : [],
    inputs_summary: JSON.parse(r.inputs_summary) as BriefingInputsSummary,
    model: r.model,
    prompt_version: r.prompt_version,
    tokens_input: r.tokens_input,
    tokens_output: r.tokens_output,
    tokens_cached: r.tokens_cached,
    cost_usd: r.cost_usd,
  };
}

export function todayUtcDate(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function getBriefing(date: string): Promise<BriefingRow | undefined> {
  const row = await get<RawBriefingRow>(
    `SELECT * FROM briefings WHERE date = ?`,
    [date],
  );
  return row ? rowToBriefing(row) : undefined;
}

export async function getLatestBriefing(): Promise<BriefingRow | undefined> {
  const row = await get<RawBriefingRow>(
    `SELECT * FROM briefings ORDER BY generated_at DESC LIMIT 1`,
  );
  return row ? rowToBriefing(row) : undefined;
}

export async function listBriefings(limit = 30): Promise<BriefingRow[]> {
  const rows = await all<RawBriefingRow>(
    `SELECT * FROM briefings ORDER BY generated_at DESC LIMIT ?`,
    [limit],
  );
  return rows.map(rowToBriefing);
}

export async function upsertBriefing(b: BriefingRow): Promise<void> {
  await run(
    `INSERT INTO briefings
       (date, generated_at, headline, regime, body, top_pick, watchlist,
        inputs_summary, model, prompt_version,
        tokens_input, tokens_output, tokens_cached, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       generated_at   = excluded.generated_at,
       headline       = excluded.headline,
       regime         = excluded.regime,
       body           = excluded.body,
       top_pick       = excluded.top_pick,
       watchlist      = excluded.watchlist,
       inputs_summary = excluded.inputs_summary,
       model          = excluded.model,
       prompt_version = excluded.prompt_version,
       tokens_input   = excluded.tokens_input,
       tokens_output  = excluded.tokens_output,
       tokens_cached  = excluded.tokens_cached,
       cost_usd       = excluded.cost_usd`,
    [
      b.date,
      b.generated_at,
      b.headline,
      b.regime,
      b.body,
      b.top_pick ? JSON.stringify(b.top_pick) : null,
      JSON.stringify(b.watchlist),
      JSON.stringify(b.inputs_summary),
      b.model,
      b.prompt_version,
      b.tokens_input,
      b.tokens_output,
      b.tokens_cached,
      b.cost_usd,
    ],
  );
}
