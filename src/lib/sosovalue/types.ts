/**
 * SoSoValue OpenAPI response types.
 *
 * Verified against real API responses (not the docs alone — the docs lie
 * in places). Fields reflect the actual server payload as of May 2026.
 *
 * Convention: keep field names exactly as the server returns them
 * (snake_case, sometimes string-encoded numbers). Conversion to camelCase
 * / typed primitives happens at the UI / domain boundary.
 */

// ─────────────────────────────────────────────────────────────────────────
// Generic envelope
// ─────────────────────────────────────────────────────────────────────────

/**
 * Standard SoSoValue envelope: { code: 0, message: "success", data: <T> }.
 * The HTTP client unwraps `.data` automatically — these types describe what
 * the inner payload looks like.
 */

export interface PaginatedResponse<T> {
  /** Total may come back as a string from the server. */
  total: number | string;
  page: number;
  page_size?: number;
  list: T[];
}

// ─────────────────────────────────────────────────────────────────────────
// Currency (1.x)
// ─────────────────────────────────────────────────────────────────────────

export interface Currency {
  currency_id: string;
  /** Lowercase symbol e.g. "btc". */
  symbol: string;
  /** Display name e.g. "BTC", "BITCOIN", "USDS". */
  name: string;
  // Older docs hint at these but they're not always present.
  full_name?: string;
  logo?: string;
  rank?: number | null;
}

/** Embedded inside news items. */
export interface MatchedCurrency {
  currency_id: string;
  symbol: string;
  name: string;
}

export interface Kline {
  /** ms timestamp — server may return as string. Use toMs() to coerce. */
  timestamp: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Volume is present for currency klines but NOT index klines. */
  volume?: number;
}

export interface KlinesQuery {
  /** Only "1d" is supported per API spec. */
  interval: "1d";
  start_time?: number;
  end_time?: number;
  /** Default 100, max 500. */
  limit?: number;
}

export interface MarketSnapshot {
  price?: number;
  market_cap?: number;
  volume_24h?: number;
  change_24h?: number;
  change_24h_percent?: number;
  fdv?: number;
  circulating_supply?: number;
  total_supply?: number;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────
// News (6.x)
// ─────────────────────────────────────────────────────────────────────────

export const NewsCategory = {
  News: 1,
  Research: 2,
  Institution: 3,
  Insights: 4,
  Announcement: 7,
  CryptoStockNews: 13,
} as const;

export type NewsCategoryValue = (typeof NewsCategory)[keyof typeof NewsCategory];

export interface MediaInfo {
  soso_url?: string;
  original_url?: string;
  short_url?: string;
  type: "photo" | "video" | "gif";
}

export interface QuoteInfo {
  content: string;
  impression_count?: number | null;
  like_count?: number | null;
  reply_count?: number | null;
  retweet_count?: number | null;
  /** ms timestamp; may be string-encoded. */
  created_at: number | string;
  media_info?: MediaInfo[] | null;
  original_url?: string;
  author_avatar_url?: string;
  author?: string;
  nick_name?: string | null;
  is_blue_verified?: boolean;
  verified_type?: string | null;
}

export interface NewsItem {
  id: string;
  source_link: string;
  original_link: string;
  /** Release time in ms. Server returns as STRING — coerce before use. */
  release_time: string | number;
  title: string;
  /** HTML content. */
  content: string;
  author: string;
  author_description: string | null;
  author_avatar_url: string;
  impression_count: number | null;
  like_count: number | null;
  reply_count: number | null;
  retweet_count: number | null;
  category: NewsCategoryValue;
  feature_image: string | null;
  nick_name: string | null;
  is_blue_verified: boolean;
  verified_type: string | null;
  matched_currencies: MatchedCurrency[] | null;
  tags: string[] | null;
  media_info: MediaInfo[] | null;
  quote_info: QuoteInfo | null;
}

export type NewsResponse = PaginatedResponse<NewsItem>;

export interface NewsQuery {
  category?: NewsCategoryValue;
  language?: NewsLanguage;
  currency_id?: string;
  project_id?: string;
  page?: number;
  page_size?: number;
  /** ms timestamp; only last 7 days supported. */
  start_time?: number;
  end_time?: number;
}

export type NewsLanguage =
  | "en"
  | "zh"
  | "tc"
  | "ja"
  | "vi"
  | "es"
  | "pt"
  | "ru"
  | "tr"
  | "fr";

/**
 * Coerce SoSoValue's possibly-stringified ms timestamp to a number.
 * Use everywhere release_time / created_at are touched.
 */
export function toMs(t: string | number | null | undefined): number {
  if (t === null || t === undefined) return 0;
  return typeof t === "number" ? t : Number(t);
}

// ─────────────────────────────────────────────────────────────────────────
// ETF (2.x) — verified against docs + live API.
//
// All "date" fields are YYYY-MM-DD strings. Volume comes back as a string.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Item from GET /etfs?symbol=BTC&country_code=US — minimal identification.
 * Use the per-fund snapshot/history endpoints for full data.
 */
export interface ETFItem {
  ticker: string;
  name: string;
  exchange: string;
  [key: string]: unknown;
}

/** Per-fund snapshot from GET /etfs/{ticker}/market-snapshot. */
export interface ETFMarketSnapshot {
  date: string; // YYYY-MM-DD
  ticker: string;
  /** Management fee, fractional (0.0025 = 0.25%). */
  sponsor_fee?: number | null;
  /** Daily net inflow in USD; negative = outflow. */
  net_inflow?: number | null;
  /** Cumulative net inflow since fund launch (USD). */
  cum_inflow?: number | null;
  /** Total net assets / AUM (USD). */
  net_assets?: number | null;
  /** Latest market price of one share. */
  mkt_price?: number | null;
  /** Premium/discount to NAV, fractional. */
  prem_dsc?: number | null;
  /** Trading volume in USD. */
  value_traded?: number | null;
  /** Share volume — server may return as string or number. */
  volume?: string | number | null;
  [key: string]: unknown;
}

/** One row from GET /etfs/{ticker}/history. */
export interface ETFHistoryRow {
  date: string;
  ticker: string;
  net_inflow?: number | null;
  cum_inflow?: number | null;
  net_assets?: number | null;
  /** Market share — fractional or percent depending on context. */
  currency_share?: number | null;
  prem_dsc?: number | null;
  value_traded?: number | null;
  volume?: string | number | null;
  [key: string]: unknown;
}

/** One row from GET /etfs/summary-history (aggregate across all funds). */
export interface ETFSummaryHistoryRow {
  /** Trading date YYYY-MM-DD. */
  date: string;
  /** Sum of net inflow across all funds for this asset/country (USD). */
  total_net_inflow?: number | null;
  /** Sum of trading volume (USD). */
  total_value_traded?: number | null;
  /** Sum of net assets / AUM (USD). */
  total_net_assets?: number | null;
  /** Cumulative since launch (USD). */
  cum_net_inflow?: number | null;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────
// SSI Index (3.x)
//
// /indices returns an array of ticker STRINGS (e.g. "ssimag7", lowercase).
// Use the per-ticker endpoints for details.
//
// VERIFIED LIVE SHAPE (May 2026) — the docs claim keys like "24h_change_pct"
// and "7day_roi" with leading digits, but the REAL response uses
// `change_pct_24h`, `roi_7d`, `roi_1m`, `roi_3m`, `roi_1y`, `ytd`.
// Trust the live shape, not the docs.
// ─────────────────────────────────────────────────────────────────────────

export type IndexTickerList = string[];

/** Response of /indices/{ticker}/market-snapshot. */
export interface IndexMarketSnapshot {
  /** Current index price. */
  price?: number;
  /** 24h price change as a fraction (e.g. -0.0247 = -2.47%). */
  change_pct_24h?: number;
  /** 7-day return as a fraction. */
  roi_7d?: number;
  /** 1-month return as a fraction. */
  roi_1m?: number;
  /** 3-month return as a fraction. */
  roi_3m?: number;
  /** 1-year return as a fraction. */
  roi_1y?: number;
  /** Year-to-date return as a fraction. */
  ytd?: number;
  [key: string]: number | undefined;
}

/**
 * Constituent of an SSI index from /indices/{ticker}/constituents.
 *
 * NOTE: `symbol` here is LONG-FORM (e.g. "bitcoin", "ethereum",
 * "binance-coin") — NOT the short ticker. To resolve to an asset use
 * `currency_id`.
 */
export interface IndexConstituent {
  currency_id: string;
  /** Long-form symbol like "bitcoin", "ethereum". */
  symbol: string;
  /** Fractional weight in the index (0..1). */
  weight: number;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────
// Crypto Stocks (4.x)
// ─────────────────────────────────────────────────────────────────────────

export interface CryptoStock {
  ticker: string;
  name: string;
  exchange: string;
  sector: string;
  introduction?: string;
  social_media?: Record<string, string>;
  listing_time?: string; // ISO date
  [key: string]: unknown;
}

export interface CryptoStockMarketSnapshot {
  ticker: string;
  price?: number;
  change_24h_percent?: number;
  market_cap?: number;
  volume?: number;
  status?: string;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────
// BTC Treasuries (5.x) — companies holding BTC on balance sheet
// Verified against the live API via scripts/inspect-btc-treasuries.ts.
// ─────────────────────────────────────────────────────────────────────────

/** Row returned by /btc-treasuries. */
export interface BtcTreasuryCompany {
  ticker: string;
  name: string;
  /** Country of primary listing — "United States", "Japan", etc. */
  list_location?: string;
  [key: string]: unknown;
}

/** Row returned by /btc-treasuries/{ticker}/purchase-history.
 *
 * Note: amount fields come back as STRINGS (btc_holding/btc_acq/acq_cost)
 * and avg_btc_cost as a NUMBER. Coerce with Number() at the call site.
 * acq_cost is sometimes missing — smaller treasuries don't disclose.
 * avg_btc_cost can be 0 or unreliable; prefer deriving from
 * acq_cost / btc_acq when both are present. */
export interface BtcTreasuryPurchase {
  /** YYYY-MM-DD UTC. */
  date: string;
  ticker: string;
  /** Total BTC holdings AFTER this transaction. */
  btc_holding: string;
  /** BTC acquired (or sold, if negative) in this transaction. */
  btc_acq: string;
  /** Total USD spent on this transaction. May be undefined / missing. */
  acq_cost?: string;
  /** Reported avg cost — unreliable; derive from acq_cost/btc_acq. */
  avg_btc_cost?: number;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────
// Sector & Spotlight (1.8)
// ─────────────────────────────────────────────────────────────────────────

export interface SectorEntry {
  name: string;
  /** 24h change as a fractional number, e.g. 0.0173 = +1.73%. */
  change_pct_24h: number;
  /** Market cap dominance, fractional 0..1. */
  marketcap_dom: number;
  [key: string]: unknown;
}

export interface SpotlightEntry {
  name: string;
  change_pct_24h: number;
  [key: string]: unknown;
}

export interface SectorSpotlight {
  /** Note: server uses singular "sector" key. */
  sector: SectorEntry[];
  spotlight?: SpotlightEntry[];
  [key: string]: unknown;
}

// Macro types live in ./macro.ts (closer to the endpoints they describe).
