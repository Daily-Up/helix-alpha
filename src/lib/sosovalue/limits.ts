/**
 * SoSoValue API constraints — single source of truth.
 *
 * These are NOT documentation guesses — they're what the docs explicitly
 * state plus what we verified against the live API. When you see a magic
 * number elsewhere in the codebase, it should reference one of these.
 */

export const ApiLimits = {
  /** /news start_time/end_time only support last 7 days. */
  NEWS_FEED_HISTORY_DAYS: 7,
  /** /news max items per page. */
  NEWS_FEED_PAGE_SIZE_MAX: 100,
  /** /news total items per response capped at 200 (per docs). */
  NEWS_FEED_RESPONSE_MAX: 200,

  /** /news/search has no documented date limit but capped per page. */
  NEWS_SEARCH_PAGE_SIZE_MAX: 50,

  /** /currencies/{id}/klines only supports 1d interval. */
  KLINES_INTERVALS: ["1d"] as const,
  /** /currencies/{id}/klines query range is last 3 months. */
  KLINES_HISTORY_DAYS: 90,
  /** /currencies/{id}/klines max records per call. */
  KLINES_LIMIT_MAX: 500,

  /** /etfs/summary-history start/end_date last 1 month only. */
  ETF_SUMMARY_HISTORY_DAYS: 30,
  /** /etfs/summary-history limit default 50, max 300. */
  ETF_SUMMARY_LIMIT_MAX: 300,

  /** /etfs/{ticker}/history last 1 month only. */
  ETF_FUND_HISTORY_DAYS: 30,
  /** /etfs/{ticker}/history limit default 50, max 300. */
  ETF_FUND_HISTORY_LIMIT_MAX: 300,

  /** /macro/events/{event}/history limit default 50, max 100. */
  MACRO_HISTORY_LIMIT_MAX: 100,
} as const;

/**
 * Documented enum values — mirror the docs literally so we can validate
 * inputs at the type level.
 */

/** Currencies supported by /etfs and /etfs/summary-history. */
export const ETF_SUPPORTED_SYMBOLS = [
  "BTC",
  "ETH",
  "SOL",
  "LTC",
  "HBAR",
  "XRP",
  "DOGE",
  "LINK",
  "AVAX",
  "DOT",
] as const;
export type ETFSupportedSymbol = (typeof ETF_SUPPORTED_SYMBOLS)[number];

/** Country codes supported by ETF endpoints. */
export const ETF_COUNTRY_CODES = ["US", "HK"] as const;
export type ETFCountryCode = (typeof ETF_COUNTRY_CODES)[number];

/**
 * Format a Date or millisecond timestamp into the YYYY-MM-DD string the
 * ETF / Macro endpoints expect.
 */
export function formatApiDate(d: Date | number): string {
  const date = typeof d === "number" ? new Date(d) : d;
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
