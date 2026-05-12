/**
 * Repository — `briefings`.
 *
 * One Claude-generated market read per day. Idempotent on the UTC date
 * column so re-running the cron doesn't create duplicates.
 */

import { db } from "../client";

export interface TopPick {
  asset_id: string;
  asset_symbol: string;
  direction: "long" | "short" | "watch";
  thesis: string;
  conviction: number; // 0..1
}

export interface WatchlistEntry {
  asset_id: string;
  symbol: string;
  note: string;
}

export type Regime = "risk_on" | "risk_off" | "mixed" | "neutral";

export interface BriefingRow {
  date: string; // YYYY-MM-DD UTC
  generated_at: number;
  headline: string;
  regime: Regime;
  body: string; // markdown
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

/** Compact summary of what went IN to the briefing. Surfaced in UI for
 *  transparency — judges/users can see exactly which data shaped the read. */
export interface BriefingInputsSummary {
  pending_signals: number;
  classifications_24h: number;
  top_event_types: Array<{ event_type: string; n: number }>;
  alphaindex_top_positions: Array<{ symbol: string; weight_pct: number }>;
  sector_top: Array<{ name: string; change_24h_pct: number }>;
  sector_bottom: Array<{ name: string; change_24h_pct: number }>;
  etf_net_flow_24h_usd: number | null;
  /** From /learnings if any — strongest empirical signal. */
  best_event_type_hit_rate: { event_type: string; hit_rate_3d: number | null; n: number } | null;
  /** Headline corporate BTC accumulation stat (last 30d). */
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

/** Today's UTC date in YYYY-MM-DD. */
export function todayUtcDate(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function getBriefing(date: string): BriefingRow | undefined {
  const row = db()
    .prepare<[string], RawBriefingRow>(
      `SELECT * FROM briefings WHERE date = ?`,
    )
    .get(date);
  return row ? rowToBriefing(row) : undefined;
}

export function getLatestBriefing(): BriefingRow | undefined {
  const row = db()
    .prepare<[], RawBriefingRow>(
      `SELECT * FROM briefings ORDER BY generated_at DESC LIMIT 1`,
    )
    .get();
  return row ? rowToBriefing(row) : undefined;
}

export function listBriefings(limit = 30): BriefingRow[] {
  const rows = db()
    .prepare<[number], RawBriefingRow>(
      `SELECT * FROM briefings ORDER BY generated_at DESC LIMIT ?`,
    )
    .all(limit);
  return rows.map(rowToBriefing);
}

export function upsertBriefing(b: BriefingRow): void {
  db()
    .prepare(
      `INSERT INTO briefings
         (date, generated_at, headline, regime, body, top_pick, watchlist,
          inputs_summary, model, prompt_version,
          tokens_input, tokens_output, tokens_cached, cost_usd)
       VALUES (@date, @generated_at, @headline, @regime, @body, @top_pick, @watchlist,
               @inputs_summary, @model, @prompt_version,
               @tokens_input, @tokens_output, @tokens_cached, @cost_usd)
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
    )
    .run({
      date: b.date,
      generated_at: b.generated_at,
      headline: b.headline,
      regime: b.regime,
      body: b.body,
      top_pick: b.top_pick ? JSON.stringify(b.top_pick) : null,
      watchlist: JSON.stringify(b.watchlist),
      inputs_summary: JSON.stringify(b.inputs_summary),
      model: b.model,
      prompt_version: b.prompt_version,
      tokens_input: b.tokens_input,
      tokens_output: b.tokens_output,
      tokens_cached: b.tokens_cached,
      cost_usd: b.cost_usd,
    });
}
