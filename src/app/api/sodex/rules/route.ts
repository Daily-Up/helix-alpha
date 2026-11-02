/**
 * GET /api/sodex/rules?symbol=BTC-USD&market=perp
 *
 * Static trading rules for one SoDEX symbol — fees, leverage, maintenance-
 * margin tiers and price/size precision. Feeds the order ticket's fee
 * breakdown, leverage cap and margin-tier liquidation estimate.
 *
 * Unlike the ticker/order book these rarely change, so the ticket fetches
 * this ONCE per symbol (not on the 4s market poll). Symbols are cached in
 * memory per market to avoid refetching the full list on every request.
 */

import { NextResponse } from "next/server";
import { Market } from "@/lib/sodex";
import type { SodexMarket } from "@/lib/sodex/market";
import type { SodexSymbol } from "@/lib/sodex/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const num = (v: string | number | undefined | null): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Module-level symbol cache (per market), 5-minute TTL.
const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map<SodexMarket, { at: number; symbols: SodexSymbol[] }>();

async function symbolsFor(market: SodexMarket): Promise<SodexSymbol[]> {
  const hit = _cache.get(market);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.symbols;
  const symbols = await Market.getSymbols(market);
  _cache.set(market, { at: Date.now(), symbols });
  return symbols;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol");
  const market = (url.searchParams.get("market") ?? "spot") as SodexMarket;
  if (!symbol) {
    return NextResponse.json(
      { ok: false, error: "symbol required" },
      { status: 400 },
    );
  }

  try {
    const symbols = await symbolsFor(market);
    const key = symbol.toUpperCase();
    const s = symbols.find(
      (x) =>
        x.name?.toUpperCase() === key ||
        x.displayName?.toUpperCase() === key,
    );
    if (!s) {
      return NextResponse.json(
        { ok: false, error: `symbol ${symbol} not found on ${market}` },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      symbol,
      market,
      rules: {
        makerFee: num(s.makerFee),
        takerFee: num(s.takerFee),
        // Perps-only; null on spot.
        maxLeverage: s.maxLeverage ?? null,
        initLeverage: s.initLeverage ?? null,
        fundingInterval: s.fundingInterval ?? 3600,
        marginTiers:
          s.marginTiers?.map((t) => ({
            maxNotionalValue: num(t.maxNotionalValue),
            maintenanceMarginRate: num(t.maintenanceMarginRate),
            maintenanceDeduction: num(t.maintenanceDeduction),
            maxLeverage: t.maxLeverage,
          })) ?? null,
        pricePrecision: num(s.pricePrecision),
        quantityPrecision: num(s.quantityPrecision),
        tickSize: num(s.tickSize),
        stepSize: num(s.stepSize),
        minPrice: num(s.minPrice),
        // perps return maxPrice "0" to mean "no cap"
        maxPrice: num(s.maxPrice),
        minQuantity: num(s.minQuantity),
        maxQuantity: num(s.maxQuantity),
        minNotional: num(s.minNotional),
        maxNotional: num(s.maxNotional),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "rules fetch failed" },
      { status: 502 },
    );
  }
}
