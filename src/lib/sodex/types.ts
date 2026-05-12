/**
 * SoDEX Spot REST API response types — verified against live mainnet.
 *
 * Numeric fields come back as STRINGS (decimal-precise). We keep them
 * as strings in these types and coerce at the call site so we don't lose
 * precision unintentionally.
 */

/** Trading-pair definition from /markets/symbols. */
export interface SodexSymbol {
  id: number;
  /** Pair name like "vBTC_vUSDC". */
  name: string;
  /** Display name like "BTC/USDC". */
  displayName: string;
  baseCoinID: number;
  baseCoin: string;
  baseCoinPrecision: number;
  quoteCoinID: number;
  quoteCoin: string;
  quoteCoinPrecision: number;
  pricePrecision: number;
  tickSize: string;
  minPrice: string;
  maxPrice: string;
  quantityPrecision: number;
  stepSize: string;
  minQuantity: string;
  maxQuantity: string;
  marketMinQuantity: string;
  marketMaxQuantity: string;
  minNotional: string;
  maxNotional: string;
  buyLimitUpRatio: string;
  sellLimitDownRatio: string;
  marketDeviationRatio: string;
  makerFee: string;
  takerFee: string;
  status: "TRADING" | "HALT" | string;
}

export interface SodexCoin {
  id: number;
  name: string;
  precision: number;
}

/** /markets/tickers shape. Numeric fields stringified. */
export interface SodexTicker {
  symbol: string;
  lastPx: string;
  openPx: string;
  highPx: string;
  lowPx: string;
  volume: string;
  /** 24h volume in quote currency (USDC). */
  quoteVolume: string;
  change: string;
  /** 24h change in % — comes back as a number despite being percent. */
  changePct: number;
  askPx: string;
  askSz: string;
  bidPx: string;
  bidSz: string;
  /** Window open in ms. */
  openTime: number;
  closeTime: number;
}

export interface SodexCandle {
  /** Open time in ms. */
  openTime: number;
  closeTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  quoteVolume: string;
  /** Number of trades. */
  trades?: number;
}

export interface SodexOrderBookLevel {
  price: string;
  size: string;
}

export interface SodexOrderBook {
  symbol: string;
  /** ms. */
  timestamp: number;
  bids: SodexOrderBookLevel[];
  asks: SodexOrderBookLevel[];
}

/** Helper to safely coerce string-encoded numbers. */
export function toNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
