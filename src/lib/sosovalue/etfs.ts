/**
 * SoSoValue ETF endpoints (2.x) — verified against the live API and docs.
 *
 * Endpoints:
 *   GET /etfs                           — list funds for (symbol, country)
 *   GET /etfs/summary-history           — daily aggregate flow per (symbol, country)
 *   GET /etfs/{ticker}/market-snapshot  — current per-fund metrics
 *   GET /etfs/{ticker}/history          — daily per-fund history
 *
 * Constraints (see ./limits.ts):
 *   • All history endpoints: only last 1 month available
 *   • limit: default 50, max 300
 *   • Date params are STRINGS in YYYY-MM-DD form (not ms timestamps)
 *   • symbol must be one of ETF_SUPPORTED_SYMBOLS
 *   • country_code must be one of ETF_COUNTRY_CODES
 */

import { sosoGet } from "./client";
import type {
  ETFCountryCode,
  ETFSupportedSymbol,
} from "./limits";
import type {
  ETFHistoryRow,
  ETFItem,
  ETFMarketSnapshot,
  ETFSummaryHistoryRow,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────
// Aggregate endpoints (require symbol + country_code)
// ─────────────────────────────────────────────────────────────────────────

export interface ETFAggregateQuery {
  symbol: ETFSupportedSymbol;
  country_code: ETFCountryCode;
  /** YYYY-MM-DD — last 1 month only. */
  start_date?: string;
  /** YYYY-MM-DD — last 1 month only. */
  end_date?: string;
  /** Default 50, max 300. */
  limit?: number;
}

/**
 * GET /etfs — list of fund tickers for an asset+country combo.
 * Response shape: [{ ticker, name, exchange }, ...]
 */
export function getETFs(query: {
  symbol: ETFSupportedSymbol;
  country_code: ETFCountryCode;
}): Promise<ETFItem[]> {
  return sosoGet<ETFItem[]>("/etfs", { query });
}

/**
 * GET /etfs/summary-history — daily aggregate flows across all funds.
 * Returns rows sorted reverse chronological (latest first).
 * Excludes weekends and holidays.
 */
export function getETFSummaryHistory(
  query: ETFAggregateQuery,
): Promise<ETFSummaryHistoryRow[]> {
  return sosoGet<ETFSummaryHistoryRow[]>("/etfs/summary-history", { query });
}

// ─────────────────────────────────────────────────────────────────────────
// Per-fund endpoints (only need ticker)
// ─────────────────────────────────────────────────────────────────────────

/** GET /etfs/{ticker}/market-snapshot — latest snapshot for one fund. */
export function getETFMarketSnapshot(
  ticker: string,
): Promise<ETFMarketSnapshot> {
  return sosoGet<ETFMarketSnapshot>(`/etfs/${ticker}/market-snapshot`);
}

/** GET /etfs/{ticker}/history — daily history for one fund (1 month max). */
export function getETFHistory(
  ticker: string,
  query?: {
    start_date?: string;
    end_date?: string;
    limit?: number;
  },
): Promise<ETFHistoryRow[]> {
  return sosoGet<ETFHistoryRow[]>(`/etfs/${ticker}/history`, { query });
}
