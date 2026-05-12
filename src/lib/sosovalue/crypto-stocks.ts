/**
 * SoSoValue Crypto Stocks endpoints (4.x).
 *
 * Covers MSTR, COIN, HOOD, mining stocks, and other public companies
 * with crypto exposure.
 */

import { sosoGet } from "./client";
import type {
  CryptoStock,
  CryptoStockMarketSnapshot,
  Kline,
  KlinesQuery,
} from "./types";

/** GET /crypto-stocks — full list of tracked stocks. */
export function getCryptoStocks(): Promise<CryptoStock[]> {
  return sosoGet<CryptoStock[]>("/crypto-stocks");
}

/** GET /crypto-stocks/{ticker}/market-snapshot */
export function getCryptoStockMarketSnapshot(
  ticker: string,
): Promise<CryptoStockMarketSnapshot> {
  return sosoGet<CryptoStockMarketSnapshot>(
    `/crypto-stocks/${ticker}/market-snapshot`,
  );
}

/** GET /crypto-stocks/{ticker}/klines */
export function getCryptoStockKlines(
  ticker: string,
  query: KlinesQuery,
): Promise<Kline[]> {
  return sosoGet<Kline[]>(`/crypto-stocks/${ticker}/klines`, { query });
}

/** GET /crypto-stocks/{ticker}/market-cap */
export function getCryptoStockMarketCap(
  ticker: string,
  query?: { start_time?: number; end_time?: number; limit?: number },
): Promise<Array<{ timestamp: number | string; market_cap: number }>> {
  return sosoGet(`/crypto-stocks/${ticker}/market-cap`, { query });
}

/** GET /crypto-stocks/sector — list of sectors. */
export function getCryptoStockSectors(): Promise<string[]> {
  return sosoGet<string[]>("/crypto-stocks/sector");
}

/** GET /crypto-stocks/sector/{sector_name}/index — sector index history. */
export function getCryptoStockSectorIndex(
  sectorName: string,
  query?: { start_time?: number; end_time?: number; limit?: number },
): Promise<
  Array<{
    timestamp: number | string;
    index_value?: number;
    [k: string]: unknown;
  }>
> {
  return sosoGet(
    `/crypto-stocks/sector/${encodeURIComponent(sectorName)}/index`,
    { query },
  );
}
