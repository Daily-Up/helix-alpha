/**
 * GET /api/data/treasuries
 *
 * Returns the corporate BTC treasury surface:
 *   - aggregate stats (companies, net BTC acquired 30d, total held)
 *   - top holders (by latest holdings)
 *   - recent purchase events (last 90d, newest first)
 */

import { NextResponse } from "next/server";
import { Treasuries, db } from "@/lib/db";

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

  const stats = Treasuries.getAggregateStats(30);

  // Top holders: latest btc_holding per company, sorted DESC.
  interface HolderRow {
    ticker: string;
    name: string;
    list_location: string | null;
    btc_holding: number;
    last_purchase_date: string;
  }
  const holders = db()
    .prepare<[], HolderRow>(
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
    )
    .all();

  const recent = Treasuries.listRecentPurchases({ daysBack: days, limit });

  return NextResponse.json({
    stats,
    holders,
    recent,
  });
}
