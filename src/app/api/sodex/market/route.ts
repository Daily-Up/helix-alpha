/**
 * GET /api/sodex/market?symbol=vBTC_vUSDC&market=spot
 *
 * Live order book + ticker for one SoDEX symbol — feeds the Trade
 * Terminal's order book and price header. Public market data (no auth).
 * Polled by the client every few seconds.
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
  if (!symbol) {
    return NextResponse.json({ ok: false, error: "symbol required" }, { status: 400 });
  }

  try {
    const [book, tickers] = await Promise.all([
      Market.getOrderBook(symbol, market, 20),
      Market.getTickers(market),
    ]);
    const ticker = tickers.find((t) => t.symbol === symbol) ?? null;
    return NextResponse.json({
      ok: true,
      symbol,
      market,
      ticker,
      bids: book.bids.slice(0, 14),
      asks: book.asks.slice(0, 14),
      timestamp: book.timestamp,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "market fetch failed" },
      { status: 502 },
    );
  }
}
