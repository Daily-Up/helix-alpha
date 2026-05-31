/**
 * Repository — `etf_flows_daily` and `etf_aggregate_daily`. Wave 2: async.
 */

import { all, batch } from "../client";
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

export async function upsertFundFlows(rows: ETFHistoryRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = `INSERT INTO etf_flows_daily (
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
     volume         = excluded.volume`;
  await batch(
    rows.map((r) => ({
      sql,
      args: [
        r.ticker,
        r.date,
        asNumber(r.net_inflow),
        asNumber(r.cum_inflow),
        asNumber(r.net_assets),
        asNumber(r.currency_share),
        asNumber(r.prem_dsc),
        asNumber(r.value_traded),
        asNumber(r.volume),
      ],
    })),
  );
  return rows.length;
}

export async function upsertAggregateFlows(
  symbol: string,
  countryCode: string,
  rows: ETFSummaryHistoryRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = `INSERT INTO etf_aggregate_daily (
     symbol, country_code, date,
     total_net_inflow, cum_net_inflow, total_net_assets, total_value_traded
   ) VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(symbol, country_code, date) DO UPDATE SET
     total_net_inflow   = excluded.total_net_inflow,
     cum_net_inflow     = excluded.cum_net_inflow,
     total_net_assets   = excluded.total_net_assets,
     total_value_traded = excluded.total_value_traded`;
  await batch(
    rows.map((r) => ({
      sql,
      args: [
        symbol,
        countryCode,
        r.date,
        asNumber(r.total_net_inflow),
        asNumber(r.cum_net_inflow),
        asNumber(r.total_net_assets),
        asNumber(r.total_value_traded),
      ],
    })),
  );
  return rows.length;
}

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

export async function getFundHistory(
  ticker: string,
  limit = 60,
): Promise<FundFlowRow[]> {
  return all<FundFlowRow>(
    `SELECT * FROM etf_flows_daily
     WHERE ticker = ?
     ORDER BY date DESC
     LIMIT ?`,
    [ticker, limit],
  );
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

export async function getAggregateHistory(
  symbol: string,
  countryCode: string,
  limit = 60,
): Promise<AggregateFlowRow[]> {
  return all<AggregateFlowRow>(
    `SELECT * FROM etf_aggregate_daily
     WHERE symbol = ? AND country_code = ?
     ORDER BY date DESC
     LIMIT ?`,
    [symbol, countryCode, limit],
  );
}
