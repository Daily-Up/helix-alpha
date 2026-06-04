/**
 * GET/POST /api/cron/refresh-klines-daily
 *
 * Rebuilds the `klines_daily` table from two sources so the agent's
 * day-level price tools (query_price_around_catalyst, query_asset_history)
 * always see fresh data:
 *   - Crypto (BTC/ETH/SOL): aggregated from historical_klines_hourly
 *   - Stocks/treasuries (29 tickers): pulled from Yahoo Finance
 *
 * Why a separate endpoint from /api/cron/ingest-klines:
 *   - ingest-klines pulls from SoSoValue, which itself can lag by weeks
 *     for daily candles. We hit that exact bug in production (klines
 *     ended 2026-05-10 while today was 2026-06-04) and the manual
 *     refresh-crypto-klines-daily.mjs / yahoo-via-curl.mjs scripts had
 *     to be run by hand. This endpoint wires those scripts into cron.
 *   - Yahoo is rate-limited per IP; running it on every tick is wasteful.
 *     Daily cadence (or twice-daily) is the right shape.
 *
 * Idempotent — upsert on (asset_id, date). Safe to call repeatedly.
 *
 * Query params:
 *   ?days=N         lookback window (default 14)
 *   ?skipStocks=1   skip Yahoo, refresh only the crypto crowd. Useful
 *                   when Yahoo is throttling or for a quick recovery.
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { refreshKlinesDaily } from "@/lib/ingest/refresh-klines-daily";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function handle(req: Request): Promise<NextResponse> {
  try {
    assertCronAuth(req);
  } catch (err) {
    return cronAuthErrorResponse(err);
  }

  const url = new URL(req.url);
  const days = url.searchParams.get("days");
  const skipStocks = url.searchParams.get("skipStocks") === "1";

  try {
    const summary = await refreshKlinesDaily({
      daysBack: days ? Number(days) : undefined,
      skipStocks,
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: (err as Error).message ?? "klines refresh failed",
      },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
