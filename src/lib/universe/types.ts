/**
 * Asset universe — canonical registry of every instrument SosoAlpha tracks.
 *
 * One Asset = one tradable / observable instrument (a token, an ETF fund,
 * a stock, a sector index, a macro indicator). Everything in the database
 * keys back to an `Asset.id` — events, klines, flows, signals.
 *
 * Each asset declares HOW we fetch it from SoSoValue (different endpoints
 * for tokens vs ETFs vs stocks vs indices vs macro), so the ingest pipeline
 * doesn't have to special-case asset types.
 */

/**
 * The 7 buckets of trackable instruments. Used both for routing API calls
 * and for filtering / grouping in the UI.
 */
export const AssetKind = {
  /** Crypto tokens (BTC, ETH, SOL, HYPE, ...). */
  Token: "token",
  /** Tokenised real-world assets (XAUT, PAXG, ONDO, ...). */
  RWA: "rwa",
  /** Spot ETF funds (IBIT, FBTC, ETHA, ...). */
  ETFFund: "etf_fund",
  /** Aggregate ETF flows for an asset+country (BTC-US, ETH-US, ...). */
  ETFAggregate: "etf_aggregate",
  /** Public companies with crypto exposure (COIN, MSTR, RIOT, ...). */
  Stock: "stock",
  /** Companies holding BTC on balance sheet (a stock subset). */
  Treasury: "treasury",
  /** SoSoValue sector indexes (ssimag7, ssidefi, ...). */
  Index: "index",
  /** Macro events / commodities (CPI, FOMC, DXY, GC1, ...). */
  Macro: "macro",
} as const;

export type AssetKindValue = (typeof AssetKind)[keyof typeof AssetKind];

/**
 * Optional convenience tags for UI grouping & default filters.
 * (e.g. tag a few alts as "L1", a few as "DeFi" — purely cosmetic.)
 */
export type AssetTag =
  | "majors"
  | "L1"
  | "L2"
  | "DeFi"
  | "Meme"
  | "AI"
  | "RWA"
  | "Mining"
  | "Exchange"
  | "Treasury"
  | "Stablecoin"
  | "Macro";

/**
 * SoDEX trading capability for an asset. Null means not tradable on SoDEX.
 *
 * Two markets exist:
 *   • spot — pairs like "vBTC_vUSDC", denominated in vUSDC, no leverage
 *   • perp — perpetual futures like "COIN-USD", with funding rates
 *
 * `status` is a snapshot from the last market refresh — pages should
 * always re-check before placing a paper trade.
 */
export interface SodexTradable {
  /**
   * Trading symbol as used by SoDEX endpoints.
   * Spot pairs look like "vBTC_vUSDC". Perp markets look like "COIN-USD".
   */
  symbol: string;
  /** Which SoDEX market the symbol belongs to. */
  market: "spot" | "perp";
  /** Base coin name (e.g. "vBTC" for spot, "COIN" for perp). */
  base: string;
  /** Quote coin name. Spot is "vUSDC", perp shows "vUSDC" internally. */
  quote: string;
  /** Last-known status: "TRADING" actively, "HALT" paused. */
  status?: "TRADING" | "HALT";
}

/** Asset definition. */
export interface Asset {
  /** Stable internal id, e.g. "tok-btc", "etf-ibit", "stk-mstr", "idx-ssimag7". */
  id: string;
  /** Display symbol (case as you'd show it). */
  symbol: string;
  /** Display name. */
  name: string;
  kind: AssetKindValue;
  tags: AssetTag[];

  /**
   * SoSoValue routing hints — only relevant for the asset's kind.
   * The ingest worker reads these to decide which endpoint(s) to call.
   */
  sosovalue: SosoValueRouting;

  /**
   * SoDEX trading hint. Set ONLY for assets that have a corresponding
   * SoDEX trading pair. Used by AlphaTrade to map signals → orders.
   */
  tradable?: SodexTradable;

  /** Optional weight for default sort/visibility (higher = more prominent). */
  rank?: number;
}

export type SosoValueRouting =
  | { kind: "token" | "rwa"; currency_id: string; symbol: string }
  | { kind: "etf_fund"; ticker: string; underlying: string; country_code: string }
  | { kind: "etf_aggregate"; symbol: string; country_code: string }
  | { kind: "stock" | "treasury"; ticker: string }
  | { kind: "index"; ticker: string }
  | { kind: "macro"; event: string };
