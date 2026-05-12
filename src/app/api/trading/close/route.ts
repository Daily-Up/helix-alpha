/**
 * POST /api/trading/close
 *
 * Manually close an open paper trade at the current SoDEX price.
 * Body: { trade_id: string }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { PaperTrades } from "@/lib/db";
import { Market } from "@/lib/sodex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ trade_id: z.string().min(1) });

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `invalid body: ${(err as Error).message}` },
      { status: 400 },
    );
  }

  const t = PaperTrades.getTrade(parsed.trade_id);
  if (!t) {
    return NextResponse.json(
      { ok: false, error: "trade not found" },
      { status: 404 },
    );
  }
  if (t.status === "closed") {
    return NextResponse.json({ ok: true, trade: t });
  }

  const tickers = await Market.getAllTickersBySymbol();
  const ticker = tickers.get(t.sodex_symbol);
  if (!ticker) {
    return NextResponse.json(
      { ok: false, error: `no live price for ${t.sodex_symbol}` },
      { status: 503 },
    );
  }
  const px = Number(ticker.lastPx);
  const closed = PaperTrades.closeTrade(parsed.trade_id, px, "manual");
  return NextResponse.json({ ok: true, trade: closed });
}
