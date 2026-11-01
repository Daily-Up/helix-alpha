/**
 * GET /api/sodex/candles?symbol=vBTC_vUSDC&market=spot&interval=1h&limit=200
 *
 * Historical OHLCV candles for the Trade Terminal chart. Public market
 * data. Returns lightweight-charts-ready rows (time in seconds).
 */

import { NextResponse } from "next/server";
import { Market } from "@/lib/sodex";
import type { SodexMarket } from "@/lib/sodex/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol");
  const market = (url.searchParams.get("market") ?? "spot") as SodexMarket;
  const interval = url.searchParams.get("interval") ?? "1h";
  const limit = Math.min(500, Math.max(20, Number(url.searchParams.get("limit") ?? 200)));
  if (!symbol) {
    return NextResponse.json({ ok: false, error: "symbol required" }, { status: 400 });
  }
  if (!ALLOWED.has(interval)) {
    return NextResponse.json({ ok: false, error: "bad interval" }, { status: 400 });
  }

  try {
    const candles = await Market.getCandles({ symbol, interval, limit }, market);
    const rows = candles
      .map((c) => ({
        time: Math.floor(c.openTime / 1000),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
      }))
      .filter((r) => Number.isFinite(r.open) && Number.isFinite(r.close))
      .sort((a, b) => a.time - b.time);
    return NextResponse.json({ ok: true, symbol, interval, candles: rows });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "candles fetch failed" },
      { status: 502 },
    );
  }
}
