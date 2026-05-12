/**
 * GET /api/data/etf-flows
 *
 * Returns ETF flow data for the /etfs dashboard. Combines:
 *   • Aggregate daily flows for an underlying (BTC, ETH, ...)
 *   • Latest per-fund snapshot for the same underlying
 *   • Per-fund history (most recent N days)
 *
 * Query params:
 *   ?symbol=BTC                (default BTC)
 *   ?country_code=US           (default US)
 *   ?days=30                   (default 30, max 60 — local DB cap)
 */

import { NextResponse } from "next/server";
import { db, ETFFlows, Assets } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FundSnapshot {
  ticker: string;
  name: string;
  exchange: string;
  net_inflow: number | null;
  cum_inflow: number | null;
  net_assets: number | null;
  prem_dsc: number | null;
  value_traded: number | null;
  date: string;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "BTC").toUpperCase();
  const country = (url.searchParams.get("country_code") ?? "US").toUpperCase();
  const days = clamp(numParam(url, "days") ?? 30, 1, 60);

  // Aggregate flow time series
  const aggHistory = ETFFlows.getAggregateHistory(symbol, country, days);
  // Reverse so the chart goes oldest → newest
  const aggregate = [...aggHistory].reverse();

  // Per-fund: take the latest row from etf_flows_daily for each ticker
  // matching this underlying (approximate by ticker prefix lookup via assets)
  const conn = db();
  const fundAssets = Assets.getAssetsByKind("etf_fund").filter((a) => {
    if (a.sosovalue.kind !== "etf_fund") return false;
    return a.sosovalue.underlying === symbol;
  });

  const fundSnapshots: FundSnapshot[] = [];
  for (const f of fundAssets) {
    if (f.sosovalue.kind !== "etf_fund") continue;
    const ticker = f.sosovalue.ticker;
    const latest = conn
      .prepare<[string], FundSnapshot>(
        `SELECT
           ticker, date, net_inflow, cum_inflow, net_assets,
           prem_dsc, value_traded,
           '' AS name, '' AS exchange
         FROM etf_flows_daily
         WHERE ticker = ?
         ORDER BY date DESC
         LIMIT 1`,
      )
      .get(ticker);
    if (latest) {
      // Patch in display-name/exchange from the assets table; the SELECT
      // returns empty strings as placeholders for these.
      latest.name = f.name;
      latest.exchange = "—";
      fundSnapshots.push(latest);
    }
  }

  // Sort by net assets descending (largest fund first)
  fundSnapshots.sort((a, b) => (b.net_assets ?? 0) - (a.net_assets ?? 0));

  // Top stats — taken from latest aggregate row
  const latestAgg = aggregate[aggregate.length - 1];
  const totals = latestAgg
    ? {
        date: latestAgg.date,
        total_net_inflow: latestAgg.total_net_inflow ?? 0,
        cum_net_inflow: latestAgg.cum_net_inflow ?? 0,
        total_net_assets: latestAgg.total_net_assets ?? 0,
        total_value_traded:
          (latestAgg as { total_value_traded?: number | null })
            .total_value_traded ?? 0,
      }
    : null;

  return NextResponse.json({
    symbol,
    country_code: country,
    totals,
    aggregate,
    funds: fundSnapshots,
  });
}

function numParam(url: URL, key: string): number | undefined {
  const v = url.searchParams.get(key);
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
