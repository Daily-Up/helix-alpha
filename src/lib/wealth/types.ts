/**
 * Types for the Wealth Index — Helix's lens over SoDEX Wealth
 * (https://sodex.com/wealth), the on-chain "private bank" catalog of
 * real-world yield + equity products.
 *
 * Data source: the public SoDEX Wealth API (wealth.sodex.dev) + per-fund
 * news from alpha-biz.sodex.dev. We never invent numbers; every field here
 * is either read straight from that API or left null when the API omits it.
 */

// ── Raw API shapes (wealth.sodex.dev/api/v1/wealth) ────────────────────

export type SodexFundType = "clob" | "escrow_vault" | "bridged_vault" | string;

/** One entry of GET /wealth/funds. */
export interface WealthFundRaw {
  fundId: string;
  name: string;
  fundType: SodexFundType;
  fundStatus: string;
  asOf: string;
  nav?: string;
  aum?: string;
  share: { coin: string; address: string; decimals: number };
  /** Present only for `clob` funds — the SoDEX spot pair they trade on. */
  spot?: {
    symbol: string;
    symbolId: number;
    displayName: string;
    quote: { coin: string; decimals: number };
  };
}

/** One entry of GET /wealth/markets `.data.quotes`. */
export interface WealthQuoteRaw {
  fundId: string;
  symbol: string;
  currency: string;
  fundType?: string;
  price?: string;
  prevClose?: string;
  changePct?: string;
  dayHigh?: string;
  dayLow?: string;
  dayVolume?: string;
  marketStatus?: string;
  asOf?: string;
  roi24h?: string;
  roi1M?: string;
  roi1Y?: string;
  roi3Y?: string;
  roiYtd?: string;
  roiInception?: string;
  apy24h?: string;
  apy7d?: string;
  apy1M?: string;
  dividendYield?: string;
  dcaReturnRate1Y?: string | null;
  dcaReturnRate3Y?: string | null;
  yieldSource?: string;
  yieldStatus?: string;
}

/** One point of GET /wealth/funds/{id}/price-history. */
export interface WealthHistoryPoint {
  ts: string;
  close: number;
}

/** One position of GET /wealth/users/{addr}/pnl `.data.positions`. */
export interface WealthPositionRaw {
  fundId: string;
  shares?: string;
  price?: string;
  marketValue?: string;
  unrealizedPnl?: string;
  realizedPnl?: string;
  pnl24h?: string;
  priced?: boolean;
}

// ── Merged / view shapes used by the UI + suggestion engine ────────────

export type WealthCategory = "stable_earn" | "curated_etf" | "specialty";

export const CATEGORY_LABEL: Record<WealthCategory, string> = {
  stable_earn: "Stable Earn",
  curated_etf: "Curated ETF",
  specialty: "Specialty",
};

/** A fund with its live market data folded in — the catalog unit. */
export interface WealthFundView {
  fundId: string;
  /** Editorial display name from SoDEX, e.g. "US Tech 100". */
  displayName: string;
  /** Underlying ticker, e.g. "QQQ". */
  symbol: string;
  category: WealthCategory;
  fundType: SodexFundType;
  blurb: string | null;
  /** True for yield products (Stable Earn) — headline is an APY, not a return. */
  isYield: boolean;

  // live numbers (null when the API omits them — never invented)
  price: number | null;
  changePct: number | null; // 24h %
  roi1Y: number | null;
  roi1M: number | null;
  roiYtd: number | null;
  roiInception: number | null;
  apy7d: number | null;
  dividendYield: number | null;
  nav: number | null;
  aum: number | null;
  marketStatus: string | null; // "TRADING" | "CLOSED" | ...

  /** The single headline metric to surface on a card. */
  headlineLabel: string; // "7D APY" | "1-Year Return" | "Since Inception"
  headlineValue: number | null;

  // trade / routing info
  shareCoin: string; // e.g. "vQQQ", "aCXMT", "vsoUSDC"
  spotSymbol: string | null; // e.g. "vQQQ_vUSDC" (clob funds only; used by option 2)
  investUrl: string; // SoDEX link (link-out for v1)
  newsSeo: string | null; // alpha-biz seoName, when known
  asOf: string | null;
}

export interface WealthPosition {
  fundId: string;
  shares: number | null;
  price: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
  pnl24h: number | null;
}

export interface WealthPortfolio {
  address: string;
  totalWealth: number | null;
  totalValue: number | null;
  settledValue: number | null;
  totalCost: number | null;
  totalPnl: number | null;
  totalPnl24h: number | null;
  totalRealizedPnl: number | null;
  totalUnrealizedPnl: number | null;
  positions: WealthPosition[];
}

// ── Suggestion engine ──────────────────────────────────────────────────

export type SuggestionKind = "efficiency" | "yield_rotation" | "event";

export interface SuggestionSource {
  label: string;
  href?: string;
  ts?: string; // ISO timestamp of the source datum
}

/**
 * A single "here's what you can do" card. Strictly factual: `observation`
 * states what is true, `option` states a thing the user could do — never a
 * directive. Every number in the text must also appear in `inputs` (which
 * lists the data points + their timestamps). If a required datum is missing
 * the card is not produced.
 */
export interface WealthSuggestion {
  id: string;
  kind: SuggestionKind;
  fundId: string | null;
  observation: string;
  option: string;
  inputs: string[];
  sources: SuggestionSource[];
  /** Risk context attached to the card (guardrail), when relevant. */
  riskNote: string | null;
  /** ISO timestamp of the freshest datum the card is built from. */
  asOf: string;
  /** Higher = more relevant; used only for ranking. */
  relevance: number;
  ctaLabel: string | null;
  ctaHref: string | null;
}
