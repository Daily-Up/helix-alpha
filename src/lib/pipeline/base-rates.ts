/**
 * Stage 5 — Base rate table.
 *
 * Replaces LLM-intuited risk parameters (every signal getting +18% target
 * regardless of asset class) with hand-curated bands per (catalyst_subtype,
 * asset_class) combination. Same nominal % on BTC and on AMZN no longer
 * comes from the same constant — they come from the historical band that
 * fits the news category × the type of asset.
 *
 * Schema and rationale: see `base_rates.json` (`_schema` field).
 *
 * Companion tests: tests/base-rates.test.ts
 *
 * Invariants: I-29 (PIPELINE_INVARIANTS.md).
 */

import RAW from "./base_rates.json";

export interface BaseRate {
  mean_move_pct: number;
  stdev_move_pct: number;
  horizon_hours: number;
  sample_size: number;
  notes: string;
}

export type AssetClass =
  | "large_cap_crypto"
  | "mid_cap_crypto"
  | "small_cap_crypto"
  | "crypto_adjacent_equity"
  | "crypto_proxy" // corpus-introduced: corp w/ BTC treasury or pure-play crypto exposure
  | "broad_equity"
  | "ai_semiconductor" // corpus-introduced: NVDA / AMD / AVGO / MU
  | "big_tech" // corpus-introduced: MSFT / META / GOOGL / AMZN / AAPL
  | "commodity"
  | "index";

// ─────────────────────────────────────────────────────────────────────────
// Asset → asset_class mapping
// ─────────────────────────────────────────────────────────────────────────

const LARGE_CAP_TOKENS = new Set(["BTC", "ETH"]);
const MID_CAP_TOKENS = new Set([
  "SOL",
  "XRP",
  "BNB",
  "ADA",
  "DOT",
  "AVAX",
  "DOGE",
  "TRX",
  "LINK",
  "LTC",
  "BCH",
  "NEAR",
  "APT",
  "ATOM",
  "FIL",
  "HBAR",
  "ICP",
  "ARB",
  "OP",
  "MATIC",
  "TON",
]);
/** Crypto-correlated stocks/treasuries — exchanges, miners, BTC-treasury cos. */
const CRYPTO_ADJACENT_EQUITIES = new Set([
  "COIN",
  "MSTR",
  "MARA",
  "RIOT",
  "HOOD",
  "CIFR",
  "IREN",
  "CLSK",
  "HUT",
  "BLOCK",
  "GLXY",
  "ABTC",
  "NAKA",
  "WULF",
  "BTCS",
  "BMNR",
  "CRCL",
  "XYZ",
  "GME",
]);
/** Commodity tickers as stored in our universe. */
const COMMODITY_SYMBOLS = new Set(["CL", "NATGAS", "COPPER", "SILVER", "XAUT"]);
/** Index tickers (broad equity indices). */
const INDEX_SYMBOLS = new Set(["US500", "USTECH100"]);

/**
 * Map an asset to one of the seven calibrated asset classes. Returns null
 * when the asset shape isn't covered (e.g., kind='macro' for a CPI event
 * symbol — those don't map to a tradable risk band, the macro event itself
 * doesn't have a target).
 */
export function classifyAssetClass(asset: {
  kind: string;
  symbol: string;
}): AssetClass | null {
  const sym = asset.symbol.toUpperCase();

  // Tokens / RWA tokens
  if (asset.kind === "token" || asset.kind === "rwa") {
    if (LARGE_CAP_TOKENS.has(sym)) return "large_cap_crypto";
    if (MID_CAP_TOKENS.has(sym)) return "mid_cap_crypto";
    if (COMMODITY_SYMBOLS.has(sym)) return "commodity"; // gold-backed RWA
    return "small_cap_crypto";
  }

  // Stocks and treasuries
  if (asset.kind === "stock" || asset.kind === "treasury") {
    if (CRYPTO_ADJACENT_EQUITIES.has(sym)) return "crypto_adjacent_equity";
    return "broad_equity";
  }

  // ETFs in our universe are crypto ETFs (IBIT, FBTC etc.) — treat as
  // large-cap crypto for risk sizing.
  if (
    asset.kind === "etf" ||
    asset.kind === "etf_fund" ||
    asset.kind === "etf_aggregate"
  ) {
    return "large_cap_crypto";
  }

  // Indexes / commodities
  if (asset.kind === "index") {
    if (COMMODITY_SYMBOLS.has(sym)) return "commodity";
    if (INDEX_SYMBOLS.has(sym)) return "index";
    // SSI sector indexes — treat as small_cap_crypto since most weight is
    // alts (they react more like a basket of mid/small caps than BTC).
    return "small_cap_crypto";
  }

  // Macro events themselves don't have an asset class.
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Lookup
// ─────────────────────────────────────────────────────────────────────────

interface RawTable {
  [subtype: string]: { [cls: string]: BaseRate } | unknown;
}

/**
 * Look up the (subtype, asset_class) base rate. Returns null if no entry
 * exists; callers fall back to the legacy `riskProfileForSubtype` and
 * MUST log the fallback (per I-29).
 */
export function getBaseRate(
  subtype: string,
  assetClass: AssetClass,
): BaseRate | null {
  const t = RAW as RawTable;
  const bucket = t[subtype];
  if (!bucket || typeof bucket !== "object") return null;
  const entry = (bucket as Record<string, BaseRate>)[assetClass];
  return entry ?? null;
}

// ─────────────────────────────────────────────────────────────────────────
// Risk derivation from a base rate
// ─────────────────────────────────────────────────────────────────────────

export interface RiskFromBaseRate {
  /** Modest target inside the typical move band: mean + 0.5σ. */
  target_pct: number;
  /** Stop at 1σ adverse — wider than target by design. */
  stop_pct: number;
  /** Time the catalyst remains tradable, from the calibration. */
  horizon_hours: number;
}

export function riskFromBaseRate(br: BaseRate): RiskFromBaseRate {
  return {
    target_pct: round1(br.mean_move_pct + 0.5 * br.stdev_move_pct),
    stop_pct: round1(br.stdev_move_pct),
    horizon_hours: br.horizon_hours,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Convert hours → the horizon-string format used by signals (e.g. "4h",
 * "12h", "2d", "5d"). Mirrors the buckets used by SUBTYPE_PROFILES so the
 * UI doesn't show a different format depending on which path won.
 */
export function horizonHoursToString(h: number): string {
  if (h <= 0) return "1h";
  if (h < 24) return `${Math.round(h)}h`;
  const days = h / 24;
  return Number.isInteger(days) ? `${days}d` : `${Math.round(days)}d`;
}

// ─────────────────────────────────────────────────────────────────────────
// Conviction cap from base rate (small-mean buckets cap at 65)
// ─────────────────────────────────────────────────────────────────────────

/**
 * If the calibrated mean move for this catalyst class is < 2%, cap the
 * conviction at 0.65. Reflects: when the typical move is small, the
 * trade has limited upside even if the mechanism reads bullish, so the
 * tier shouldn't reach AUTO regardless of LLM enthusiasm.
 */
export function shouldCapConvictionFromBaseRate(br: BaseRate): {
  cap: boolean;
  ceiling: number;
  reason: string;
} {
  if (br.mean_move_pct < 2.0) {
    return {
      cap: true,
      ceiling: 0.65,
      reason: `base_rate_small_mean (mean=${br.mean_move_pct}%, ceiling 0.65)`,
    };
  }
  return { cap: false, ceiling: 1.0, reason: "" };
}

// ─────────────────────────────────────────────────────────────────────────
// Pre-save gate helper — target_exceeds_base_rate
// ─────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the signal's target_pct exceeds 2× the calibrated
 * (mean + stdev) for its (subtype, class). The gate refuses these so a
 * LLM-or-formula-induced "+18% on AMZN earnings" doesn't slip past us
 * just because the upstream stage forgot the table.
 */
export function exceedsBaseRateTarget(
  targetPct: number,
  br: BaseRate,
): boolean {
  const ceiling = 2 * (br.mean_move_pct + br.stdev_move_pct);
  return targetPct > ceiling;
}

/** Same idea but exposes the ceiling for audit messages. */
export function baseRateTargetCeiling(br: BaseRate): number {
  return 2 * (br.mean_move_pct + br.stdev_move_pct);
}
