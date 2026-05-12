/**
 * SoSoValue Currency & Pairs endpoints (1.x).
 *
 * Klines: only daily ("1d") interval; max 3 months history; max 500 per call.
 */

import { sosoGet } from "./client";
import type { Currency, Kline, KlinesQuery, MarketSnapshot } from "./types";

/** GET /currencies — list of all listed currencies. */
export function getCurrencies(): Promise<Currency[]> {
  return sosoGet<Currency[]>("/currencies");
}

/** GET /currencies/{id} — currency details. */
export function getCurrency(currencyId: string): Promise<Currency> {
  return sosoGet<Currency>(`/currencies/${currencyId}`);
}

/** GET /currencies/{id}/market-snapshot — current price + market metrics. */
export function getCurrencyMarketSnapshot(
  currencyId: string,
): Promise<MarketSnapshot> {
  return sosoGet<MarketSnapshot>(`/currencies/${currencyId}/market-snapshot`);
}

/** GET /currencies/{id}/klines — daily OHLCV. */
export function getCurrencyKlines(
  currencyId: string,
  query: KlinesQuery,
): Promise<Kline[]> {
  return sosoGet<Kline[]>(`/currencies/${currencyId}/klines`, { query });
}

/**
 * Convenience: fetch the last N days of daily klines for a currency.
 * Caps at 90 days because the API only retains 3 months.
 */
export function getDailyKlines(
  currencyId: string,
  daysBack: number,
): Promise<Kline[]> {
  const limit = Math.min(500, Math.max(1, Math.floor(daysBack)));
  return getCurrencyKlines(currencyId, { interval: "1d", limit });
}

// /currencies/sector-spotlight lives in ./sector.ts — kept separate so
// the narrative-cycle module can import it without pulling in everything.
