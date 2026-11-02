/**
 * GET /api/sodex/tickers?market=perp
 *
 * All tickers for a market in a single request (SoDEX /markets/tickers with
 * no symbol filter), reduced to a { SYMBOL: mark } map plus a { SYMBOL:
 * {rate,next} } funding map. Feeds the Positions table so every open position
 * — not just the selected market — shows a live mark price (and its liq
 * warning) and an account-wide "est. next funding" estimate. Public market
 * data (no auth). Polled by the client at the same cadence as the ticker.
 */

import { NextResponse } from "next/server";
import { Market } from "@/lib/sodex";
import type { SodexMarket } from "@/lib/sodex/market";
import type { SodexTicker } from "@/lib/sodex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const market = (url.searchParams.get("market") ?? "perp") as SodexMarket;

  try {
    // No symbol → SoDEX returns every symbol's ticker in one response.
    const tickers = await Market.getTickers(market);
    const marks: Record<string, number> = {};
    // Per-symbol funding: rate (raw fraction per interval) + next funding time
    // (ms). Perps rows carry fundingRate + nextFundingTime (not in the shared
    // type); absent on spot, so the map simply stays empty there.
    const funding: Record<string, { rate: number; next: number }> = {};
    for (const t of tickers) {
      const row = t as SodexTicker & {
        markPrice?: string;
        fundingRate?: string;
        nextFundingTime?: number;
      };
      const sym = t.symbol.toUpperCase();
      // Perps rows carry markPrice (not in the shared type); fall back to last.
      const m = Number(row.markPrice ?? t.lastPx);
      if (Number.isFinite(m)) marks[sym] = m;
      const rate = Number(row.fundingRate);
      if (Number.isFinite(rate)) {
        const next = Number(row.nextFundingTime);
        funding[sym] = { rate, next: Number.isFinite(next) ? next : 0 };
      }
    }
    return NextResponse.json({ ok: true, market, marks, funding });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "tickers fetch failed" },
      { status: 502 },
    );
  }
}
