/**
 * Regime cap — Pipeline-side check that prevents AUTO-tier signals from
 * firing into a clearly counter-trend tape.
 *
 * The complaint that motivated this: Helix LONG'd BTC while BTC was
 * "shooting down". The catalyst can be real (corporate buy, ETF inflow),
 * but if BTC is in a deep drawdown with falling 30d returns, even strong
 * fundamentals don't beat the tape over 1-3 day horizons. A signal in
 * that regime belongs at REVIEW (manual approval) or INFO, not AUTO.
 *
 * Rule of thumb (long-only — symmetric short rule applied independently):
 *
 *   IF direction = "long"
 *   AND regime.trend = "down"
 *   AND regime.drawdown_pct < -8
 *   AND regime.rsi_14 < 40
 *   THEN cap tier to "review" (or "info" if already there).
 *
 * The same rule applies for SHORT into trend=up with drawdown > -3% and
 * rsi > 60.
 *
 * The data source is `historical_klines_hourly` (Binance public,
 * ingested by scripts/ingest-binance-history.mjs). Tokens, stocks, and
 * treasuries all map to the BTC regime as a proxy because crypto-
 * adjacent equities track BTC tightly on 1-3d horizons.
 */

import { getRegime, type RegimeSnapshot } from "@/lib/regime/classifier";

export interface RegimeCapInput {
  direction: "long" | "short";
  asset_kind: string;
  asset_symbol: string;
  current_tier: "auto" | "review" | "info";
}

export interface RegimeCapResult {
  /** Tier after the cap. Same as input when no cap fired. */
  tier: "auto" | "review" | "info";
  /** True when the cap fired. */
  capped: boolean;
  /** Human-readable explanation (added to signal reasoning). */
  reason: string | null;
  /** The regime snapshot used, for transparency. */
  regime: RegimeSnapshot | null;
}

/** Symbols where we directly query the asset's own regime. */
const DIRECT_SYMBOLS = new Set(["BTC", "ETH", "SOL"]);

/** Asset kinds that should NOT be regime-checked (no crypto exposure). */
const SKIP_KINDS = new Set([
  "macro",     // macro events — no asset-specific tape to fight
  "index",     // baskets are too aggregated to apply a single regime
  "rwa",       // real-world assets — not driven by BTC tape
  "etf_fund",  // ETF flow signals fire on the ETF; underlying check would
  "etf_aggregate",
]);

/**
 * Pick which symbol's regime to read for the given asset. We have hourly
 * data for BTC, ETH, SOL. For everything else crypto-adjacent we use BTC
 * as the proxy — corporate-treasury stocks, mid-cap tokens, etc. all
 * track BTC on 1-3d horizons.
 */
function pickRegimeSymbol(asset_kind: string, asset_symbol: string): string | null {
  if (SKIP_KINDS.has(asset_kind)) return null;
  const sym = asset_symbol.toUpperCase();
  if (DIRECT_SYMBOLS.has(sym)) return sym;
  return "BTC";
}

/**
 * Apply the regime cap. Reads regime from historical_klines_hourly.
 * Returns the input tier unchanged when the data isn't available or
 * the regime is benign.
 */
export async function capTierForRegime(
  input: RegimeCapInput,
): Promise<RegimeCapResult> {
  // INFO is already as low as we cap; no-op.
  if (input.current_tier === "info") {
    return { tier: "info", capped: false, reason: null, regime: null };
  }

  const symbol = pickRegimeSymbol(input.asset_kind, input.asset_symbol);
  if (!symbol) {
    return { tier: input.current_tier, capped: false, reason: null, regime: null };
  }

  const regime = await getRegime(symbol);
  if (!regime) {
    return { tier: input.current_tier, capped: false, reason: null, regime: null };
  }

  const counterTrendLong =
    input.direction === "long" &&
    regime.trend === "down" &&
    regime.drawdown_pct < -8 &&
    regime.rsi_14 < 40;

  const counterTrendShort =
    input.direction === "short" &&
    regime.trend === "up" &&
    regime.drawdown_pct > -3 &&
    regime.rsi_14 > 60;

  if (!counterTrendLong && !counterTrendShort) {
    return { tier: input.current_tier, capped: false, reason: null, regime };
  }

  // Cap AUTO → REVIEW. Don't cap REVIEW further; manual reviewers can
  // overrule the regime if the catalyst justifies it. The goal is to
  // remove AUTO-fires that look obviously counter-trend.
  if (input.current_tier !== "auto") {
    return { tier: input.current_tier, capped: false, reason: null, regime };
  }

  const reason =
    `Counter-trend ${input.direction.toUpperCase()} into ${symbol} ${regime.trend} regime ` +
    `(close $${regime.close.toLocaleString()}, ${regime.drawdown_pct.toFixed(1)}% from ATH ` +
    `${regime.days_since_ath}d ago, RSI=${regime.rsi_14.toFixed(0)}, ` +
    `30d return ${regime.return_30d_pct?.toFixed(1) ?? "n/a"}%). ` +
    `Downgraded to REVIEW — catalyst may still be valid but the tape is fighting it.`;

  return {
    tier: "review",
    capped: true,
    reason,
    regime,
  };
}
