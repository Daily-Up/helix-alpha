/**
 * SoSoValue SSI Index endpoints (3.x).
 *
 * NOTE: /indices returns an array of ticker STRINGS (e.g. "ssiSocialFi"),
 * not full objects. Use the per-ticker snapshot/constituents/klines
 * endpoints to get details.
 */

import { sosoGet } from "./client";
import type {
  IndexConstituent,
  IndexMarketSnapshot,
  IndexTickerList,
  Kline,
  KlinesQuery,
} from "./types";

/** GET /indices — list of SSI index tickers. */
export function getIndices(): Promise<IndexTickerList> {
  return sosoGet<IndexTickerList>("/indices");
}

/** GET /indices/{ticker}/market-snapshot */
export function getIndexMarketSnapshot(
  ticker: string,
): Promise<IndexMarketSnapshot> {
  return sosoGet<IndexMarketSnapshot>(`/indices/${ticker}/market-snapshot`);
}

/** GET /indices/{ticker}/constituents */
export function getIndexConstituents(
  ticker: string,
): Promise<IndexConstituent[]> {
  return sosoGet<IndexConstituent[]>(`/indices/${ticker}/constituents`);
}

/** GET /indices/{ticker}/klines */
export function getIndexKlines(
  ticker: string,
  query: KlinesQuery,
): Promise<Kline[]> {
  return sosoGet<Kline[]>(`/indices/${ticker}/klines`, { query });
}
