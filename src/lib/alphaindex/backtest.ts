/**
 * Historical replay of the AlphaIndex allocation framework — Part 1.
 *
 * Walks daily price data, rebalances on a fixed cadence, applies the
 * SAME momentum-tilt logic as the live engine, and emits a NAV series
 * + drawdown / Sharpe / vs-BTC metrics.
 *
 * IMPORTANT — zero-news mode. The replay assumes news signals = 0
 * because we don't have a historical archive of classified news to
 * replay against. This means stress-test results reflect ONLY the
 * momentum + anchor framework, NOT the production strategy (which
 * adds signal boosts on top). Read all replay outputs as
 * "what does the framework do without news guidance" — the live
 * strategy is necessarily different, and may be better or worse.
 *
 * Companion tests: tests/alphaindex-backtest.test.ts.
 */

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface DailyBar {
  asset_id: string;
  /** YYYY-MM-DD UTC. */
  date: string;
  ts_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MomentumOnlyInput {
  asof_ms: number;
  /** asset_id → 30d return as a fraction (0.10 = +10%, -0.30 = -30%). */
  momentum_30d: Map<string, number>;
  /** Anchor weights: asset_id → base weight (must sum to <= 1). */
  anchors: Record<string, number>;
  /** Tilt budget (currently unused — non-anchor tilts run via momentum
   *  on the anchor weights themselves; kept for parity with live engine). */
  tilt_budget: number;
  non_anchor_cap: number;
  anchor_max: number;
}

export interface NavPoint {
  ts_ms: number;
  /** Daily-close mark-to-market. */
  nav_usd: number;
}

export interface WeightSnapshot {
  ts_ms: number;
  weights: Map<string, number>;
}

export interface ReplayInput {
  start_ms: number;
  end_ms: number;
  /** Per-asset daily bar series, indexed by asset_id. */
  series: Map<string, DailyBar[]>;
  /** Anchor weights mirroring the live engine. */
  anchors: Record<string, number>;
  starting_nav: number;
  rebalance_freq_days: number;
}

export interface ReplayResult {
  daily_nav: NavPoint[];
  weight_history: WeightSnapshot[];
  rebalance_count: number;
  return_pct: number;
  max_drawdown_pct: number;
  sharpe: number | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Pure allocator — same shape as live, news signals forced to 0
// ─────────────────────────────────────────────────────────────────────────

/** Translate 30d return → tilt multiplier ~ [0.4, 1.6]. Mirror of the
 *  live engine's `momentumToMultiplier`. */
function momentumToMultiplier(ret30d: number | undefined): number {
  if (ret30d == null) return 1.0;
  return 1 + 0.6 * Math.tanh(ret30d * 2);
}

/** Hard floor: drop assets with sustained -25%+ 30d return AND no
 *  positive signal (signals=0 here, so the AND collapses to "drop"). */
const HARD_FLOOR_30D = -0.25;

/**
 * Compute a momentum-only weight allocation (signals = 0). Mirrors the
 * live engine's anchor + tilt structure but skips the signal-boost step
 * entirely. After capping, weights are L1-normalized so the portfolio
 * sums to 1.0.
 */
export function computeMomentumOnlyWeights(
  input: MomentumOnlyInput,
): Map<string, number> {
  const out = new Map<string, number>();

  for (const [assetId, baseW] of Object.entries(input.anchors)) {
    const ret30 = input.momentum_30d.get(assetId);

    // Hard floor — drop assets in deep drawdown.
    if (ret30 != null && ret30 < HARD_FLOOR_30D) continue;

    const mMom = momentumToMultiplier(ret30);
    // Apply multiplier, then cap.
    const tilted = baseW * mMom;
    const capped = Math.min(tilted, input.anchor_max);
    out.set(assetId, capped);
  }

  // L1-normalize so the surviving weights sum to 1.0 (otherwise dropped
  // anchors leak budget into "cash" which the backtest has no model for).
  const total = [...out.values()].reduce((s, x) => s + x, 0);
  if (total > 0) {
    for (const [k, v] of out.entries()) out.set(k, v / total);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Walk price series — daily mark-to-market with periodic rebalance
// ─────────────────────────────────────────────────────────────────────────

/**
 * Lookup the close price of `asset_id` on the day-of-or-before `ts_ms`.
 * Returns null when no bar covers the date.
 */
function priceAtOrBefore(
  series: DailyBar[],
  ts_ms: number,
): { close: number; ts_ms: number } | null {
  // Bars are assumed sorted ascending by ts_ms.
  let best: DailyBar | null = null;
  for (const b of series) {
    if (b.ts_ms <= ts_ms) best = b;
    else break;
  }
  return best ? { close: best.close, ts_ms: best.ts_ms } : null;
}

/**
 * Compute a 30d return for asset using bars on/before `asof_ms`.
 * Returns null if we don't have a bar from ≥30d earlier.
 */
function compute30dReturn(
  series: DailyBar[],
  asof_ms: number,
): number | null {
  const today = priceAtOrBefore(series, asof_ms);
  if (!today) return null;
  const lookbackMs = asof_ms - 30 * 24 * 3600 * 1000;
  const earlier = priceAtOrBefore(series, lookbackMs);
  if (!earlier || earlier.close <= 0) return null;
  return (today.close - earlier.close) / earlier.close;
}

/**
 * Replay the strategy day-by-day. Quantities are recomputed at each
 * rebalance from current weights × NAV ÷ price; in between, NAV
 * marks to market against close prices.
 *
 * If an asset has no bar on a given day, its position holds the last
 * known mark — i.e., we treat a missing bar as flat. This matches how
 * a real portfolio treats halted instruments.
 */
export function walkPriceSeries(input: ReplayInput): ReplayResult {
  const dayMs = 24 * 3600 * 1000;
  const days = Math.floor((input.end_ms - input.start_ms) / dayMs) + 1;
  const dailyNav: NavPoint[] = [];
  const weightHistory: WeightSnapshot[] = [];

  let nav = input.starting_nav;
  let quantities = new Map<string, number>(); // asset_id → units
  let rebalanceCount = 0;

  for (let d = 0; d < days; d++) {
    const ts = input.start_ms + d * dayMs;

    // ── Rebalance day? ──
    const isRebalance = d === 0 || d % input.rebalance_freq_days === 0;
    if (isRebalance) {
      // Compute momentum based on bars up to today.
      const momentum = new Map<string, number>();
      for (const [assetId, bars] of input.series.entries()) {
        const ret = compute30dReturn(bars, ts);
        if (ret != null) momentum.set(assetId, ret);
      }
      const targetWeights = computeMomentumOnlyWeights({
        asof_ms: ts,
        momentum_30d: momentum,
        anchors: input.anchors,
        tilt_budget: 1 - sumValues(input.anchors),
        non_anchor_cap: 0.05,
        anchor_max: 0.7,
      });

      // Convert weights → quantities at today's prices.
      const newQuantities = new Map<string, number>();
      for (const [assetId, w] of targetWeights.entries()) {
        const series = input.series.get(assetId);
        if (!series) continue;
        const px = priceAtOrBefore(series, ts);
        if (!px || px.close <= 0) continue;
        newQuantities.set(assetId, (nav * w) / px.close);
      }
      quantities = newQuantities;
      weightHistory.push({ ts_ms: ts, weights: targetWeights });
      rebalanceCount++;
    }

    // ── Mark to market ──
    let mtm = 0;
    for (const [assetId, qty] of quantities.entries()) {
      const series = input.series.get(assetId);
      if (!series) continue;
      const px = priceAtOrBefore(series, ts);
      if (!px || px.close <= 0) continue;
      mtm += qty * px.close;
    }
    if (mtm > 0) nav = mtm;
    dailyNav.push({ ts_ms: ts, nav_usd: nav });
  }

  const metrics = computeRunMetrics(dailyNav);
  return {
    daily_nav: dailyNav,
    weight_history: weightHistory,
    rebalance_count: rebalanceCount,
    return_pct: metrics.return_pct,
    max_drawdown_pct: metrics.max_drawdown_pct,
    sharpe: metrics.sharpe,
  };
}

function sumValues(o: Record<string, number>): number {
  return Object.values(o).reduce((s, x) => s + x, 0);
}

// ─────────────────────────────────────────────────────────────────────────
// Run metrics
// ─────────────────────────────────────────────────────────────────────────

export interface RunMetrics {
  return_pct: number;
  max_drawdown_pct: number;
  sharpe: number | null;
  alpha_vs_btc_pct: number | null;
  sample_days: number;
}

/**
 * Return / max DD / Sharpe from a NAV series. Optional `btc_navs` lets
 * callers compute alpha (return delta) over the same window.
 */
export function computeRunMetrics(
  navs: NavPoint[],
  btc_navs?: NavPoint[],
): RunMetrics {
  if (navs.length < 2) {
    return {
      return_pct: 0,
      max_drawdown_pct: 0,
      sharpe: null,
      alpha_vs_btc_pct: null,
      sample_days: navs.length,
    };
  }

  const start = navs[0].nav_usd;
  const end = navs[navs.length - 1].nav_usd;
  const ret = start > 0 ? ((end - start) / start) * 100 : 0;

  // Daily log returns → Sharpe (annualized, rf=0).
  const logRets: number[] = [];
  for (let i = 1; i < navs.length; i++) {
    const a = navs[i - 1].nav_usd;
    const b = navs[i].nav_usd;
    if (a > 0 && b > 0) logRets.push(Math.log(b / a));
  }
  let sharpe: number | null = null;
  if (logRets.length >= 2) {
    const mean = logRets.reduce((s, x) => s + x, 0) / logRets.length;
    const variance =
      logRets.reduce((s, x) => s + (x - mean) ** 2, 0) / logRets.length;
    const sd = Math.sqrt(variance);
    sharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : null;
  }

  // Max drawdown: rolling peak.
  let peak = navs[0].nav_usd;
  let maxDD = 0;
  for (const n of navs) {
    if (n.nav_usd > peak) peak = n.nav_usd;
    const dd = peak > 0 ? (n.nav_usd - peak) / peak : 0;
    if (dd < maxDD) maxDD = dd;
  }

  // vs-BTC alpha when provided.
  let alpha: number | null = null;
  if (btc_navs && btc_navs.length >= 2) {
    const btcStart = btc_navs[0].nav_usd;
    const btcEnd = btc_navs[btc_navs.length - 1].nav_usd;
    if (btcStart > 0) {
      const btcRet = ((btcEnd - btcStart) / btcStart) * 100;
      alpha = ret - btcRet;
    }
  }

  return {
    return_pct: round1(ret),
    max_drawdown_pct: round1(maxDD * 100),
    sharpe: sharpe != null ? round1(sharpe) : null,
    alpha_vs_btc_pct: alpha != null ? round1(alpha) : null,
    sample_days: navs.length,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
