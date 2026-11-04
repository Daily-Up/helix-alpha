/**
 * Event Stream ↔ SoDEX market mapping.
 *
 * Maps a classifier `affected_asset_id` (e.g. "stk-amd", "tok-sol", "perp-us500",
 * "trs-mstr") to its SoDEX perp market ("AMD-USD", "SOL-USD", "US500-USD") when
 * one exists, and buckets assets into equity / crypto / index / commodity /
 * macro for the For You / Equities / Crypto tabs and the movers rails.
 *
 * SoDEX perps have no category on their symbols, so base tickers are classified
 * here. This module is client-safe (pure, no server imports) and is the single
 * source of truth shared by the trade terminal and the Event Stream.
 */

export type MarketCategory =
  | "equity"
  | "crypto"
  | "index"
  | "commodity"
  | "macro";

/** Known stock / commodity / index perp bases (SoDEX gives no category). */
export const STOCK_BASES = new Set([
  "NVDA", "AMZN", "BABA", "TSLA", "AAPL", "MSFT", "GOOGL", "GOOG", "META",
  "MSTR", "COIN", "CRWD", "MRNA", "NBIS", "TSM", "SAMSUNG", "KIOXIA", "SPCX",
  "ZHIPU", "UNITREE", "CXMT", "DRAM", "NFLX", "AMD", "PLTR", "HOOD", "AVGO",
  "ORCL", "SMCI", "ASML", "INTC", "QCOM", "MU", "ARM", "UBER", "SHOP", "DIS",
  "BA", "JPM", "WMT", "COST", "MRVL", "DELL", "IBM", "CSCO", "ADBE", "CRM",
  "NOW", "SNOW", "NET", "DDOG", "PANW", "ANET", "ABNB", "RBLX", "RIVN", "LCID",
  "NIO", "XPEV", "LI", "SOUN", "BBAI", "RGTI", "QBTS", "IONQ", "PYPL", "SQ",
  "NKE", "MCD", "SNDK", "CRWV", "WLFI", "EWY", "BREV", "MINIMAX", "NIULAI",
]);
export const COMMODITY_BASES = new Set([
  "COPPER", "NATGAS", "SILVER", "GOLD", "PLATINUM", "PALLADIUM", "OIL",
  "BRENT", "BRENTOIL", "WTI", "SLV", "GLD", "USO", "NG", "ALUMINUM", "ZINC",
  "NICKEL", "CORN", "WHEAT", "SOYBEAN", "SUGAR", "COFFEE", "CL", "XAUT", "XAUT",
]);
export const INDEX_BASES = new Set([
  "USTECH100", "US500", "SPX500", "SPX", "NDX", "NAS100", "US30", "DJI",
  "DJIA", "RUT", "RTY", "VIX", "DAX", "FTSE", "NIKKEI", "HSI", "US2000",
]);

/** Classify a SoDEX perp base ticker (shared with the trade terminal). */
export function baseCategory(base: string): MarketCategory {
  const b = base.toUpperCase();
  if (INDEX_BASES.has(b)) return "index";
  if (COMMODITY_BASES.has(b)) return "commodity";
  if (STOCK_BASES.has(b)) return "equity";
  return "crypto";
}

/**
 * Base-ticker aliases where the classifier symbol differs from SoDEX's perp
 * base — mostly the 1000× meme perps, plus a few index spellings.
 */
const BASE_ALIAS: Record<string, string> = {
  PEPE: "1000PEPE",
  BONK: "1000BONK",
  SHIB: "1000SHIB",
  SP500: "US500",
  SPX: "US500",
  SPX500: "US500",
  NASDAQ: "USTECH100",
  NASDAQ100: "USTECH100",
  NDX: "USTECH100",
  NAS100: "USTECH100",
  GOLD: "XAUT",
  XAU: "XAUT",
  CRUDE: "CL",
  WTI: "CL",
  BRENT: "BRENTOIL",
};

/** The prefix of an affected_asset_id maps to a broad category. */
function prefixCategory(prefix: string): MarketCategory | null {
  switch (prefix) {
    case "stk":
    case "trs":
      return "equity";
    case "tok":
    case "rwa":
      return "crypto";
    case "perp":
    case "idx":
      return "index";
    case "mac":
    case "macro":
      return "macro";
    default:
      return null;
  }
}

export interface AssetRef {
  /** The original affected_asset_id, e.g. "stk-amd". */
  id: string;
  /** Display ticker, e.g. "AMD". */
  ticker: string;
  /** Broad bucket for tabs / rails. */
  category: MarketCategory;
  /** SoDEX perp market ("AMD-USD") if tradable, else null. */
  sodexSymbol: string | null;
}

/** Split an affected_asset_id into {prefix, base}. "stk-amd" → {stk, amd}. */
function splitAssetId(assetId: string): { prefix: string; base: string } {
  const i = assetId.indexOf("-");
  if (i < 0) return { prefix: "", base: assetId };
  return { prefix: assetId.slice(0, i), base: assetId.slice(i + 1) };
}

/**
 * Resolve an affected_asset_id to its display ticker, category and (if the
 * market exists in `perpSet`) its SoDEX perp symbol. `perpSet` is the set of
 * live perp names ("AMD-USD", …) — pass it so only genuinely tradable assets
 * get a trade button.
 */
export function resolveAsset(
  assetId: string,
  perpSet?: Set<string>,
): AssetRef {
  const { prefix, base } = splitAssetId(assetId);
  const rawTicker = base.replace(/[^a-z0-9]/gi, "").toUpperCase();
  const perpBase = BASE_ALIAS[rawTicker] ?? rawTicker;
  const candidate = `${perpBase}-USD`;
  const sodexSymbol = perpSet
    ? perpSet.has(candidate)
      ? candidate
      : null
    : candidate;
  const category =
    prefixCategory(prefix) ??
    (sodexSymbol ? baseCategory(perpBase) : "crypto");
  // Equities/indices/commodities keep their own bucket even when the prefix
  // was generic; a "tok-" that maps to a known stock base is rare but handled.
  const refined =
    category === "crypto" && sodexSymbol ? baseCategory(perpBase) : category;
  return { id: assetId, ticker: rawTicker, category: refined, sodexSymbol };
}

/** Default order side from an event's sentiment. */
export function defaultSide(
  sentiment: "positive" | "negative" | "neutral" | null,
): "long" | "short" {
  return sentiment === "negative" ? "short" : "long";
}

/** Perp display name convention used across the app (BTC-USD → BTC-PERP). */
export function perpDisplay(sodexSymbol: string): string {
  return sodexSymbol.replace(/-USDC?$/i, "-PERP");
}
