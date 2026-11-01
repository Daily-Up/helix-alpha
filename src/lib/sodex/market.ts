/**
 * SoDEX Market endpoints — works against either spot or perps.
 *
 * Both markets share the same URL shape (`/markets/symbols`, `/markets/tickers`
 * etc.) but live under different base URLs:
 *   spot:  https://mainnet-gw.sodex.dev/api/v1/spot
 *   perp:  https://mainnet-gw.sodex.dev/api/v1/perps
 *
 * Pass `market` to choose. Defaults to "spot" so existing callers keep
 * working without changes.
 */

import { spotGet, baseFor } from "./client";
import type {
  SodexCandle,
  SodexCoin,
  SodexOrderBook,
  SodexSymbol,
  SodexTicker,
} from "./types";

export type SodexMarket = "spot" | "perp";

export interface CandlesQuery {
  symbol: string;
  /** "1m", "5m", "15m", "1h", "4h", "1d", etc. */
  interval: "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | string;
  startTime?: number;
  endTime?: number;
  limit?: number;
}

/** GET /markets/symbols on the chosen market. */
export function getSymbols(market: SodexMarket = "spot"): Promise<SodexSymbol[]> {
  return spotGet<SodexSymbol[]>("/markets/symbols", {
    baseOverride: baseFor(market),
  });
}

/** GET /markets/coins (spot only — perps doesn't expose this). */
export function getCoins(): Promise<SodexCoin[]> {
  return spotGet<SodexCoin[]>("/markets/coins");
}

/**
 * GET /markets/tickers on the chosen market. Pass `symbol` to let SoDEX
 * filter server-side (one row) — perps rows carry markPrice, indexPrice,
 * openInterest, fundingRate and nextFundingTime.
 */
export function getTickers(
  market: SodexMarket = "spot",
  symbol?: string,
): Promise<SodexTicker[]> {
  return spotGet<SodexTicker[]>("/markets/tickers", {
    query: symbol ? { symbol } : undefined,
    baseOverride: baseFor(market),
  });
}

/**
 * GET /markets/{symbol}/orderbook?limit= — L2 depth for one pair.
 * SoDEX returns bids/asks as [price, size] string tuples; we normalize
 * to the SodexOrderBook {price, size} level shape.
 */
export async function getOrderBook(
  symbol: string,
  market: SodexMarket = "spot",
  depth?: number,
): Promise<SodexOrderBook> {
  const raw = await spotGet<{
    bids: [string, string][];
    asks: [string, string][];
    blockTime?: number;
  }>(`/markets/${encodeURIComponent(symbol)}/orderbook`, {
    query: { limit: depth },
    baseOverride: baseFor(market),
  });
  return {
    symbol,
    timestamp: raw.blockTime ?? Date.now(),
    bids: (raw.bids ?? []).map(([price, size]) => ({ price, size })),
    asks: (raw.asks ?? []).map(([price, size]) => ({ price, size })),
  };
}

/**
 * GET /markets/{symbol}/klines?interval=&limit= — historical OHLCV.
 * SoDEX returns short-key rows {t,o,h,l,c,v,q,n}; we map to SodexCandle.
 */
export async function getCandles(
  query: CandlesQuery,
  market: SodexMarket = "spot",
): Promise<SodexCandle[]> {
  const { symbol, interval, startTime, endTime, limit } = query;
  const raw = await spotGet<
    Array<{
      t: number;
      o: string;
      h: string;
      l: string;
      c: string;
      v: string;
      q: string;
      n?: number;
    }>
  >(`/markets/${encodeURIComponent(symbol)}/klines`, {
    query: { interval, startTime, endTime, limit },
    baseOverride: baseFor(market),
  });
  return (raw ?? []).map((k) => ({
    openTime: k.t,
    closeTime: k.t,
    open: k.o,
    high: k.h,
    low: k.l,
    close: k.c,
    volume: k.v,
    quoteVolume: k.q,
    trades: k.n,
  }));
}

/** Tickers (spot only) indexed by symbol. */
export async function getTickersBySymbol(
  market: SodexMarket = "spot",
): Promise<Map<string, SodexTicker>> {
  const tickers = await getTickers(market);
  const m = new Map<string, SodexTicker>();
  for (const t of tickers) m.set(t.symbol, t);
  return m;
}

/**
 * Tickers from BOTH spot and perp markets, indexed by symbol.
 *
 * Use this when you have a mix of tradable assets — the symbol format
 * disambiguates (vBTC_vUSDC vs BTC-USD), so a single map works.
 */
export async function getAllTickersBySymbol(): Promise<Map<string, SodexTicker>> {
  const [spot, perp] = await Promise.all([
    getTickers("spot").catch(() => [] as SodexTicker[]),
    getTickers("perp").catch(() => [] as SodexTicker[]),
  ]);
  const m = new Map<string, SodexTicker>();
  for (const t of spot) m.set(t.symbol, t);
  for (const t of perp) m.set(t.symbol, t);
  return m;
}
