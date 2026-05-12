/**
 * GET /api/data/portfolio
 *
 * Returns portfolio snapshot:
 *   • settings (so UI knows starting balance, auto-trade state)
 *   • stats   (equity, realised + unrealised P&L, win rate)
 *   • open positions with mark-to-market live prices
 *   • closed trade history
 */

import { NextResponse } from "next/server";
import { PaperTrades, Settings } from "@/lib/db";
import { Market } from "@/lib/sodex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface OpenWithMarks {
  id: string;
  asset_id: string;
  sodex_symbol: string;
  direction: "long" | "short";
  size_usd: number;
  entry_price: number;
  entry_time: number;
  stop_price: number | null;
  target_price: number | null;
  current_price: number | null;
  unrealised_pnl_usd: number | null;
  unrealised_pnl_pct: number | null;
}

export async function GET() {
  const settings = Settings.getSettings();
  // Fetch from spot + perps so positions on either market mark-to-market.
  const tickers = await Market.getAllTickersBySymbol().catch(
    () => new Map<string, never>(),
  );

  const livePrices = new Map<string, number>();
  for (const [sym, t] of tickers as unknown as Map<
    string,
    { lastPx: string }
  >) {
    livePrices.set(sym, Number(t.lastPx));
  }

  const open = PaperTrades.listOpen();
  const openWithMarks: OpenWithMarks[] = open.map((t) => {
    const px = livePrices.get(t.sodex_symbol) ?? null;
    let pnl_usd: number | null = null;
    let pnl_pct: number | null = null;
    if (px != null) {
      const r = PaperTrades.computePnl(
        t.direction,
        t.size_usd,
        t.entry_price,
        px,
      );
      pnl_usd = r.pnl_usd;
      pnl_pct = r.pnl_pct;
    }
    return {
      id: t.id,
      asset_id: t.asset_id,
      sodex_symbol: t.sodex_symbol,
      direction: t.direction,
      size_usd: t.size_usd,
      entry_price: t.entry_price,
      entry_time: t.entry_time,
      stop_price: t.stop_price,
      target_price: t.target_price,
      current_price: px,
      unrealised_pnl_usd: pnl_usd,
      unrealised_pnl_pct: pnl_pct,
    };
  });

  const stats = PaperTrades.portfolioStats(
    settings.paper_starting_balance_usd,
    livePrices,
  );

  const closed = PaperTrades.listAll(50).filter((t) => t.status === "closed");

  return NextResponse.json({
    settings,
    stats,
    open: openWithMarks,
    closed,
  });
}
