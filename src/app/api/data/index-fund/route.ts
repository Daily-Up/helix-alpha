/**
 * GET /api/data/index-fund?id=alphacore
 *
 * Returns the snapshot the AlphaIndex dashboard needs:
 *   - index header (name, description, starting NAV)
 *   - latest NAV + benchmark prices
 *   - current positions (mark-to-market)
 *   - rebalance history
 *   - NAV history for the equity curve chart
 */

import { NextResponse } from "next/server";
import { Assets, IndexFund, Settings, db } from "@/lib/db";
import { Market } from "@/lib/sodex";
import {
  buildBenchmarkSpec,
  computeBenchmarkSeries,
  type BenchmarkName,
  type DailyBar,
} from "@/lib/alphaindex/benchmarks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PositionView {
  asset_id: string;
  symbol: string;
  name: string;
  sodex_symbol: string;
  market: "spot" | "perp" | null;
  target_weight: number;
  quantity: number;
  avg_entry_price: number | null;
  current_price: number | null;
  current_value_usd: number;
  unrealised_pnl_usd: number | null;
  unrealised_pnl_pct: number | null;
  current_weight: number;
  rationale: string | null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const indexId = url.searchParams.get("id") ?? "alphacore";

  const idx = IndexFund.getIndex(indexId);
  if (!idx) {
    return NextResponse.json({ ok: false, error: "index not found" }, { status: 404 });
  }

  const settings = Settings.getSettings();
  const tickers = await Market.getAllTickersBySymbol().catch(
    () => new Map<string, never>(),
  );
  const livePrice = (sym: string): number | null => {
    const t = (tickers as unknown as Map<string, { lastPx: string }>).get(sym);
    if (!t) return null;
    const n = Number(t.lastPx);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // ── Mark positions to market ──────────────────────────────────
  const rawPositions = IndexFund.listPositions(indexId);
  const positions: PositionView[] = [];
  let invested = 0;

  for (const p of rawPositions) {
    const asset = Assets.getAssetById(p.asset_id);
    if (!asset) continue;
    const sodex = asset.tradable?.symbol ?? "";
    const px = sodex ? livePrice(sodex) : null;
    const value = px != null ? p.quantity * px : p.current_value_usd;
    const pnl_usd =
      px != null && p.avg_entry_price != null
        ? p.quantity * (px - p.avg_entry_price)
        : null;
    const pnl_pct =
      px != null && p.avg_entry_price != null && p.avg_entry_price > 0
        ? ((px - p.avg_entry_price) / p.avg_entry_price) * 100
        : null;

    positions.push({
      asset_id: p.asset_id,
      symbol: asset.symbol,
      name: asset.name,
      sodex_symbol: sodex,
      market: asset.tradable?.market ?? null,
      target_weight: p.target_weight,
      quantity: p.quantity,
      avg_entry_price: p.avg_entry_price,
      current_price: px,
      current_value_usd: value,
      unrealised_pnl_usd: pnl_usd,
      unrealised_pnl_pct: pnl_pct,
      current_weight: 0, // filled below
      rationale: p.rationale,
    });
    invested += value;
  }

  // Cash & NAV
  const lastNavRow = IndexFund.listNavHistory(indexId, 1)[0];
  const lastNav = lastNavRow?.nav_usd ?? idx.starting_nav;
  const cash = Math.max(0, lastNav - invested);
  const nav = invested + cash;

  // Fill current_weight using NAV.
  for (const p of positions) {
    p.current_weight = nav > 0 ? p.current_value_usd / nav : 0;
  }
  positions.sort((a, b) => b.current_value_usd - a.current_value_usd);

  // ── Rebalance history ─────────────────────────────────────────
  const rebalances = IndexFund.listRebalances(indexId, 30);

  // ── NAV history for equity curve ──────────────────────────────
  // The real `index_nav_history` table only has rows for days the
  // rebalance worker has run. For a meaningful chart we backfill a
  // synthetic 30d NAV using each position's current quantity × the
  // historical close that day. This answers the investor's first
  // question — "would I have made more just holding BTC?" — by
  // showing the full curve, not just two dots.
  const real_nav_history = IndexFund.listNavHistory(indexId, 90);
  const synthetic_nav_history = buildSyntheticNavHistory(
    indexId,
    positions,
    cash,
    30,
  );
  // Use synthetic when the real table has fewer rows than the synthetic
  // (which it almost always does in practice). The chart is labeled
  // "backtest" so the user knows it's a what-if curve, not a track record.
  const nav_history =
    synthetic_nav_history.length > real_nav_history.length
      ? synthetic_nav_history
      : real_nav_history;
  const is_backfill =
    synthetic_nav_history.length > real_nav_history.length;

  // ── Benchmark prices for the chart ────────────────────────────
  const btc_now = livePrice("vBTC_vUSDC");
  const ssimag7_now = livePrice("vMAG7ssi_vUSDC");

  // ── Benchmark NAV series (Part 2) ─────────────────────────────
  // Compute "naive momentum top-7" and "hybrid simple" NAVs over the
  // same date window as the equity curve. These get layered into the
  // chart as toggleable lines and a mini-table beneath.
  const benchmark_curves = computeBenchmarkOverlays(nav_history, idx.starting_nav);

  // ── Risk metrics ──────────────────────────────────────────────
  const risk = computeRiskMetrics(nav_history);

  return NextResponse.json({
    index: idx,
    is_backfill,
    risk,
    settings: {
      auto_rebalance: settings.index_auto_rebalance,
      min_position_pct: settings.index_min_position_pct,
      max_position_pct: settings.index_max_position_pct,
      cash_reserve_pct: settings.index_cash_reserve_pct,
      review_with_claude: settings.index_review_with_claude,
    },
    nav: {
      total: nav,
      invested,
      cash,
      starting: idx.starting_nav,
      pnl_usd: nav - idx.starting_nav,
      pnl_pct:
        idx.starting_nav > 0
          ? ((nav - idx.starting_nav) / idx.starting_nav) * 100
          : 0,
    },
    positions,
    rebalances,
    nav_history,
    benchmarks: {
      btc_now,
      ssimag7_now,
    },
    benchmark_curves,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Benchmark overlays (Part 2)
// ─────────────────────────────────────────────────────────────────────────

interface BenchmarkOverlay {
  name: BenchmarkName;
  /** date (YYYY-MM-DD) → NAV in USD, normalized so it shares the
   *  same starting NAV as AlphaCore for chart-overlay comparability. */
  nav_by_date: Record<string, number>;
  return_pct: number;
  max_drawdown_pct: number;
  sharpe: number | null;
}

/**
 * Run the two benchmark specs over the date window of `nav_history` and
 * align their NAV series to the same dates. We seed with the live
 * starting NAV so the chart's three lines all begin at the same y-value.
 *
 * If kline coverage is too thin to drive a benchmark we still return a
 * stub so the UI knows the toggle should be disabled — the NAV map will
 * be empty in that case.
 */
function computeBenchmarkOverlays(
  nav_history: Array<{ date: string }>,
  startingNav: number,
): BenchmarkOverlay[] {
  if (nav_history.length < 2) return [];
  const conn = db();
  // Find date range
  const dates = nav_history.map((r) => r.date);
  const start_ms = Date.parse(dates[0] + "T00:00:00Z");
  const end_ms = Date.parse(dates[dates.length - 1] + "T00:00:00Z");
  if (!Number.isFinite(start_ms) || !Number.isFinite(end_ms)) return [];

  // Pull all daily bars for assets we might need. The naive benchmark
  // can use the entire universe; the hybrid spec only needs BTC + the
  // four hardcoded equities. Loading all assets keeps the universe wide
  // for the momentum benchmark without a per-spec query.
  const rows = conn
    .prepare<[], { asset_id: string; date: string; open: number; high: number; low: number; close: number }>(
      `SELECT asset_id, date, open, high, low, close FROM klines_daily
       ORDER BY asset_id, date ASC`,
    )
    .all();
  const series = new Map<string, DailyBar[]>();
  for (const r of rows) {
    const ts = Date.parse(r.date + "T00:00:00Z");
    if (!Number.isFinite(ts)) continue;
    let bars = series.get(r.asset_id);
    if (!bars) {
      bars = [];
      series.set(r.asset_id, bars);
    }
    bars.push({
      asset_id: r.asset_id,
      date: r.date,
      ts_ms: ts,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
    });
  }
  if (series.size === 0) return [];

  const overlays: BenchmarkOverlay[] = [];
  const names: BenchmarkName[] = ["naive_momentum_top7", "hybrid_simple"];
  for (const name of names) {
    try {
      const result = computeBenchmarkSeries({
        spec: buildBenchmarkSpec(name),
        start_ms,
        end_ms,
        series,
        starting_nav: startingNav,
      });
      const nav_by_date: Record<string, number> = {};
      for (const p of result.daily_nav) {
        const d = new Date(p.ts_ms).toISOString().slice(0, 10);
        nav_by_date[d] = p.nav_usd;
      }
      overlays.push({
        name,
        nav_by_date,
        return_pct: result.return_pct,
        max_drawdown_pct: result.max_drawdown_pct,
        sharpe: result.sharpe,
      });
    } catch {
      overlays.push({
        name,
        nav_by_date: {},
        return_pct: 0,
        max_drawdown_pct: 0,
        sharpe: null,
      });
    }
  }
  return overlays;
}

// ─────────────────────────────────────────────────────────────────────────
// Synthetic NAV backfill
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a `days`-long synthetic equity curve assuming the user invested
 * in the CURRENT allocation that many days ago. For each day we sum
 * `quantity × close_that_day` across positions and add cash.
 *
 * Positions without a kline for a given day fall back to their
 * `current_value_usd` for that day (i.e. assumed flat) — this preserves
 * total NAV continuity rather than dropping the position. The chart is
 * already labeled "backtest" so this conservative assumption is safe.
 *
 * Benchmark columns (btc_price, ssimag7_price) are pulled from the
 * klines_daily table for `tok-btc` and `idx-ssimag7`. Either may be
 * null if no kline exists for that asset / date.
 */
function buildSyntheticNavHistory(
  indexId: string,
  positions: PositionView[],
  cashUsd: number,
  days: number,
): Array<{
  index_id: string;
  date: string;
  nav_usd: number;
  pnl_usd: number;
  pnl_pct: number;
  btc_price: number | null;
  ssimag7_price: number | null;
}> {
  const conn = db();
  // Build the date list (newest -> oldest), then reverse for chart.
  const dates = conn
    .prepare<[number], { date: string }>(
      `SELECT DISTINCT date FROM klines_daily
       WHERE asset_id = 'tok-btc'
       ORDER BY date DESC
       LIMIT ?`,
    )
    .all(days)
    .map((r) => r.date)
    .reverse();
  if (dates.length === 0) return [];

  // Per-position kline maps: asset_id -> date -> close
  const closeByDate = new Map<string, Map<string, number>>();
  for (const p of positions) {
    const rows = conn
      .prepare<[string], { date: string; close: number }>(
        `SELECT date, close FROM klines_daily WHERE asset_id = ?`,
      )
      .all(p.asset_id);
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.date, r.close);
    closeByDate.set(p.asset_id, m);
  }

  // Benchmarks
  const btcMap = closeByDate.get("tok-btc") ?? new Map();
  const ssimag7Rows = conn
    .prepare<[], { date: string; close: number }>(
      `SELECT date, close FROM klines_daily WHERE asset_id = 'idx-ssimag7'`,
    )
    .all();
  const ssimag7Map = new Map<string, number>();
  for (const r of ssimag7Rows) ssimag7Map.set(r.date, r.close);

  // Starting NAV for the synthetic curve = current invested + cash (today).
  // We work backwards: each day's NAV is sum(quantity × close) + cash.
  // The implicit assumption is that the allocation was held flat for
  // the lookback — true for a "what if I bought-and-held" backtest.
  const out: Array<{
    index_id: string;
    date: string;
    nav_usd: number;
    pnl_usd: number;
    pnl_pct: number;
    btc_price: number | null;
    ssimag7_price: number | null;
  }> = [];

  // The starting baseline is each position's current_value_usd; if a
  // historical close is missing we keep that value.
  let baselineNav: number | null = null;
  for (const date of dates) {
    let positionsValue = 0;
    for (const p of positions) {
      const m = closeByDate.get(p.asset_id);
      const close = m?.get(date);
      if (close != null && p.quantity > 0) {
        positionsValue += p.quantity * close;
      } else {
        // No kline this day — use today's value as a flat fallback.
        positionsValue += p.current_value_usd;
      }
    }
    const nav = positionsValue + cashUsd;
    if (baselineNav == null) baselineNav = nav;
    out.push({
      index_id: indexId,
      date,
      nav_usd: nav,
      pnl_usd: nav - baselineNav,
      pnl_pct:
        baselineNav > 0 ? ((nav - baselineNav) / baselineNav) * 100 : 0,
      btc_price: btcMap.get(date) ?? null,
      ssimag7_price: ssimag7Map.get(date) ?? null,
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Risk metrics
// ─────────────────────────────────────────────────────────────────────────

interface RiskMetrics {
  /** Annualized realized vol from daily NAV log returns. */
  vol_30d_annualized_pct: number | null;
  /** Largest peak-to-trough drawdown over the window, in %. */
  max_drawdown_pct: number | null;
  /** Current drawdown from the rolling high, in % (0 if at all-time high). */
  current_drawdown_pct: number | null;
  /** Cumulative AlphaCore return over the window, in %. */
  return_pct: number | null;
  /** Cumulative BTC return over the same window, in %. */
  btc_return_pct: number | null;
  /** Outperformance vs BTC, in %-points (alpha). */
  alpha_vs_btc_pct: number | null;
  /** Naive Sharpe ratio (rf=0, daily). */
  sharpe: number | null;
  /** How many days of NAV data the metrics were computed from. */
  sample_days: number;
}

function computeRiskMetrics(
  history: Array<{
    nav_usd: number;
    btc_price: number | null;
  }>,
): RiskMetrics {
  if (history.length < 2) {
    return {
      vol_30d_annualized_pct: null,
      max_drawdown_pct: null,
      current_drawdown_pct: null,
      return_pct: null,
      btc_return_pct: null,
      alpha_vs_btc_pct: null,
      sharpe: null,
      sample_days: history.length,
    };
  }
  const navs = history.map((r) => r.nav_usd);
  const navStart = navs[0];
  const navEnd = navs[navs.length - 1];
  const returnPct = navStart > 0 ? ((navEnd - navStart) / navStart) * 100 : 0;

  // Daily log returns for vol + sharpe
  const logRets: number[] = [];
  for (let i = 1; i < navs.length; i++) {
    if (navs[i - 1] > 0 && navs[i] > 0) {
      logRets.push(Math.log(navs[i] / navs[i - 1]));
    }
  }
  const mean = logRets.reduce((s, x) => s + x, 0) / Math.max(1, logRets.length);
  const variance =
    logRets.reduce((s, x) => s + (x - mean) ** 2, 0) /
    Math.max(1, logRets.length);
  const dailyStd = Math.sqrt(variance);
  const annualizedVol = dailyStd * Math.sqrt(365) * 100;
  const sharpe = dailyStd > 0 ? (mean / dailyStd) * Math.sqrt(365) : null;

  // Max drawdown: scan rolling peak
  let peak = navs[0];
  let maxDD = 0;
  for (const n of navs) {
    if (n > peak) peak = n;
    const dd = peak > 0 ? (n - peak) / peak : 0;
    if (dd < maxDD) maxDD = dd;
  }
  const currentDD = peak > 0 ? ((navEnd - peak) / peak) * 100 : 0;

  // BTC return over same window (skipping null prices)
  const btcPrices = history
    .map((r) => r.btc_price)
    .filter((v): v is number => v != null && v > 0);
  let btcReturn: number | null = null;
  if (btcPrices.length >= 2) {
    btcReturn =
      ((btcPrices[btcPrices.length - 1] - btcPrices[0]) / btcPrices[0]) * 100;
  }
  const alpha =
    btcReturn != null ? returnPct - btcReturn : null;

  return {
    vol_30d_annualized_pct: Number.isFinite(annualizedVol)
      ? Math.round(annualizedVol * 10) / 10
      : null,
    max_drawdown_pct: Math.round(maxDD * 1000) / 10,
    current_drawdown_pct: Math.round(currentDD * 10) / 10,
    return_pct: Math.round(returnPct * 100) / 100,
    btc_return_pct: btcReturn != null ? Math.round(btcReturn * 100) / 100 : null,
    alpha_vs_btc_pct: alpha != null ? Math.round(alpha * 100) / 100 : null,
    sharpe: sharpe != null ? Math.round(sharpe * 100) / 100 : null,
    sample_days: history.length,
  };
}
