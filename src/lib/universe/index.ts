/**
 * Public surface for the asset universe.
 *
 * Import from "@/lib/universe" — keeps the resolver/cache/watchlist
 * coupling private to this folder.
 */

export * from "./types";
export {
  DEFAULT_UNIVERSE,
  findAsset,
  assetsByKind,
  assetsByTag,
} from "./default-watchlist";
export {
  resolveCurrencyId,
  lookupCurrency,
  refreshCurrencyCache,
  resolveUniverse,
} from "./resolver";
