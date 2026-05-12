/**
 * Repository — `etf_flows_daily` and `etf_aggregate_daily`.
 *
 * Per-fund flows come from /etfs/{ticker}/history; aggregate flows from
 * /etfs/summary-history. We store both because they answer different
 * questions (BlackRock vs Fidelity competition  vs  total institutional
 * appetite).
 */

import { db } from "../client";
import type {
  ETFHistoryRow,
  ETFSummaryHistoryRow,
} from "@/lib/sosovalue";

function asNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Upsert per-fund daily flows. */
export function upsertFundFlows(rows: ETFHistoryRow[]): number {
  if (rows.length === 0) return 0;
  const stmt = db().prepare(
    `INSERT INTO etf_flows_daily (
       ticker, date, net_inflow, cum_inflow, net_assets,
       currency_share, prem_dsc, value_traded, volume
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticker, date) DO UPDATE SET
       net_inflow     = excluded.net_inflow,
       cum_inflow     = excluded.cum_inflow,
       net_assets     = excluded.net_assets,
       currency_share = excluded.currency_share,
       prem_dsc       = excluded.prem_dsc,
       value_traded   = excluded.value_traded,
       volume         = excluded.volume`,
  );
  const tx = db().transaction((items: ETFHistoryRow[]) => {
    let n = 0;
    for (const r of items) {
      stmt.run(
        r.ticker,
        r.date,
        asNumber(r.net_inflow),
        asNumber(r.cum_inflow),
        asNumber(r.net_assets),
        asNumber(r.currency_share),
        asNumber(r.prem_dsc),
        asNumber(r.value_traded),
        asNumber(r.volume),
      );
      n++;
    }
    return n;
  });
  return tx(rows);
}

/** Upsert aggregate flows for (symbol, country_code). */
export function upsertAggregateFlows(
  symbol: string,
  countryCode: string,
  rows: ETFSummaryHistoryRow[],
): number {
  if (rows.length === 0) return 0;
  const stmt = db().prepare(
    `INSERT INTO etf_aggregate_daily (
       symbol, country_code, date,
       total_net_inflow, cum_net_inflow, total_net_assets, total_value_traded
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, country_code, date) DO UPDATE SET
       total_net_inflow   = excluded.total_net_inflow,
       cum_net_inflow     = excluded.cum_net_inflow,
       total_net_assets   = excluded.total_net_assets,
       total_value_traded = excluded.total_value_traded`,
  );
  const tx = db().transaction((items: ETFSummaryHistoryRow[]) => {
    let n = 0;
    for (const r of items) {
      stmt.run(
        symbol,
        countryCode,
        r.date,
        asNumber(r.total_net_inflow),
        asNumber(r.cum_net_inflow),
        asNumber(r.total_net_assets),
        asNumber(r.total_value_traded),
      );
      n++;
    }
    return n;
  });
  return tx(rows);
}

/** Read per-fund history for charts. */
export interface FundFlowRow {
  ticker: string;
  date: string;
  net_inflow: number | null;
  cum_inflow: number | null;
  net_assets: number | null;
  currency_share: number | null;
  prem_dsc: number | null;
  value_traded: number | null;
  volume: number | null;
}

export function getFundHistory(ticker: string, limit = 60): FundFlowRow[] {
  return db()
    .prepare<[string, number], FundFlowRow>(
      `SELECT * FROM etf_flows_daily
       WHERE ticker = ?
       ORDER BY date DESC
       LIMIT ?`,
    )
    .all(ticker, limit);
}

export interface AggregateFlowRow {
  symbol: string;
  country_code: string;
  date: string;
  total_net_inflow: number | null;
  cum_net_inflow: number | null;
  total_net_assets: number | null;
  total_value_traded: number | null;
}

export function getAggregateHistory(
  symbol: string,
  countryCode: string,
  limit = 60,
): AggregateFlowRow[] {
  return db()
    .prepare<[string, string, number], AggregateFlowRow>(
      `SELECT * FROM etf_aggregate_daily
       WHERE symbol = ? AND country_code = ?
       ORDER BY date DESC
       LIMIT ?`,
    )
    .all(symbol, countryCode, limit);
}
