/**
 * GET /api/sodex/trades?symbol=BTC-USD&market=perp&limit=40
 *
 * Recent public trades for one SoDEX symbol — feeds the terminal's Trades
 * tape. Public market data (no auth). Polled by the client.
 */

import { NextResponse } from "next/server";
import { Market } from "@/lib/sodex";
import type { SodexMarket } from "@/lib/sodex/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol");
  const market = (url.searchParams.get("market") ?? "spot") as SodexMarket;
  const limit = Math.min(100, Number(url.searchParams.get("limit")) || 40);
  if (!symbol) {
    return NextResponse.json(
      { ok: false, error: "symbol required" },
      { status: 400 },
    );
  }

  try {
    const trades = await Market.getTrades(symbol, market, limit);
    return NextResponse.json({ ok: true, symbol, market, trades });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "trades fetch failed" },
      { status: 502 },
    );
  }
}
