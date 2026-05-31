/**
 * GET /api/data/treasuries — corporate BTC treasuries. Wave 2: async.
 */

import { NextResponse } from "next/server";
import { Treasuries, all } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const days = Math.min(
    365,
    Math.max(1, Number(url.searchParams.get("days") ?? 90)),
  );
  const limit = Math.min(
    500,
    Math.max(1, Number(url.searchParams.get("limit") ?? 100)),
  );

  const stats = await Treasuries.getAggregateStats(30);

  interface HolderRow {
    ticker: string;
    name: string;
    list_location: string | null;
    btc_holding: number;
    last_purchase_date: string;
  }
  const holders = await all<HolderRow>(
    `SELECT
       c.ticker,
       c.name,
       c.list_location,
       latest.btc_holding,
       latest.date AS last_purchase_date
     FROM btc_treasury_companies c
     JOIN (
       SELECT ticker, btc_holding, date,
              ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
       FROM btc_treasury_purchases
     ) latest ON latest.ticker = c.ticker AND latest.rn = 1
     ORDER BY latest.btc_holding DESC
     LIMIT 25`,
  );

  const recent = await Treasuries.listRecentPurchases({
    daysBack: days,
    limit,
  });

  return NextResponse.json({
    stats,
    holders,
    recent,
  });
}
