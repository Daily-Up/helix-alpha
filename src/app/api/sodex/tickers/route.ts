/**
 * GET /api/sodex/tickers?market=perp
 *
 * All tickers for a market in a single request (SoDEX /markets/tickers with
 * no symbol filter), reduced to a { SYMBOL: mark } map. Feeds the Positions
 * table so every open position — not just the selected market — shows a live
 * mark price (and its liq warning). Public market data (no auth). Polled by
 * the client at the same cadence as the selected-market ticker.
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
    for (const t of tickers) {
      // Perps rows carry markPrice (not in the shared type); fall back to last.
      const raw = (t as SodexTicker & { markPrice?: string }).markPrice ?? t.lastPx;
      const m = Number(raw);
      if (Number.isFinite(m)) marks[t.symbol.toUpperCase()] = m;
    }
    return NextResponse.json({ ok: true, market, marks });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "tickers fetch failed" },
      { status: 502 },
    );
  }
}
