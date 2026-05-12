/**
 * GET /api/data/alphaindex/v2-status
 *
 * Drives the v2 framework end-to-end for the dashboard tab:
 *   1. Loads kline data
 *   2. Runs v2 backtest over the 3 stress windows + 5 random 60-day
 *      windows (overfitting check)
 *   3. Runs v1's naive-momentum benchmark over the live period for C2
 *   4. Evaluates the 3 acceptance criteria
 *   5. Persists the result to `v2_acceptance` and returns it
 *
 * Cached at the request level only — fresh evaluation every page load
 * so a recent rebalance is reflected immediately. Cheap because
 * computeBenchmarkSeries memoizes its work and runV2Backtest is pure.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runV2Backtest } from "@/lib/alphaindex/v2/backtest-v2";
import {
  evaluateAcceptance,
  recordAcceptance,
  type StressWindowResult,
} from "@/lib/alphaindex/v2/acceptance";
import {
  buildBenchmarkSpec,
  computeBenchmarkSeries,
  type DailyBar,
} from "@/lib/alphaindex/benchmarks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY_MS = 24 * 3600 * 1000;
const STARTING_NAV = 10_000;
const WINDOW_DAYS = 60;
const RANDOM_WINDOWS = 5;
const RNG_SEED = 0x517c0de; // deterministic random windows

interface Window {
  label: string;
  start_ms: number;
  end_ms: number;
  start_date: string;
  end_date: string;
  source: "fixed_drawdown" | "fixed_recent" | "random";
}

export async function GET() {
  try {
    const series = loadAllSeries();
    if (series.size === 0) {
      return NextResponse.json({
        ok: false,
        error: "no kline data — cannot run v2 stress tests",
      });
    }

    const btcBars = series.get("tok-btc") ?? [];
    if (btcBars.length < WINDOW_DAYS + 5) {
      return NextResponse.json({
        ok: false,
        error: `insufficient BTC kline coverage (${btcBars.length}d) — need >= ${WINDOW_DAYS + 5}`,
      });
    }

    // ── 1. Define stress windows: fixed worst-DD x2 + recent + 5 random
    const windows = pickStressWindows(btcBars);

    // ── 2. Run v2 backtest in each window + collect BTC max DD
    const stressResults: StressWindowResult[] = [];
    const v2BacktestSummaries: unknown[] = [];

    for (const w of windows) {
      const v2 = runV2Backtest({
        start_ms: w.start_ms,
        end_ms: w.end_ms,
        series,
        starting_nav: STARTING_NAV,
      });
      const btcDD = computeBtcMaxDD(btcBars, w.start_ms, w.end_ms);
      const btcStats = computeBtcSharpe(btcBars, w.start_ms, w.end_ms);
      stressResults.push({
        label: w.label,
        start_date: w.start_date,
        end_date: w.end_date,
        v2_max_dd_pct: v2.max_drawdown_pct,
        btc_max_dd_pct: btcDD,
        v2_return_pct: v2.return_pct,
        v2_sharpe: v2.sharpe,
        btc_sharpe: btcStats.sharpe,
        btc_return_pct: btcStats.ret_pct,
      });
      v2BacktestSummaries.push({
        window: w.label,
        return_pct: v2.return_pct,
        max_drawdown_pct: v2.max_drawdown_pct,
        sharpe: v2.sharpe,
        rebalance_count: v2.rebalance_count,
        regime_breakdown: regimeBreakdown(v2.regime_trace),
        source: w.source,
      });
    }

    // ── 3. Live-period: run v2 on the most-recent 30d, compare to
    // naive-momentum benchmark over the same range
    const liveStart = btcBars[Math.max(0, btcBars.length - 30)].ts_ms;
    const liveEnd = btcBars[btcBars.length - 1].ts_ms;

    const v2Live = runV2Backtest({
      start_ms: liveStart,
      end_ms: liveEnd,
      series,
      starting_nav: STARTING_NAV,
    });

    const naiveSpec = buildBenchmarkSpec("naive_momentum_top7");
    const naiveResult = computeBenchmarkSeries({
      spec: naiveSpec,
      start_ms: liveStart,
      end_ms: liveEnd,
      series,
      starting_nav: STARTING_NAV,
    });

    // ── 4. BTC buy-and-hold over the same live period (for C2)
    const btcLive = computeBtcLiveSummary(btcBars, liveStart, liveEnd);

    // ── 5. Evaluate acceptance (v2.1 criteria)
    const acceptance = evaluateAcceptance({
      index_id: "alphacore",
      stress_windows: stressResults,
      v2_live_return_pct: v2Live.return_pct,
      v2_live_max_dd_pct: v2Live.max_drawdown_pct,
      btc_live_return_pct: btcLive.return_pct,
      btc_live_max_dd_pct: btcLive.max_dd_pct,
      naive_live_return_pct: naiveResult.return_pct,
    });

    // ── 6. Persist
    const liveSummary = {
      v2_return_pct: v2Live.return_pct,
      v2_max_dd_pct: v2Live.max_drawdown_pct,
      v2_sharpe: v2Live.sharpe,
      btc_return_pct: btcLive.return_pct,
      btc_max_dd_pct: btcLive.max_dd_pct,
      naive_return_pct: naiveResult.return_pct,
      naive_max_dd_pct: naiveResult.max_drawdown_pct,
      naive_sharpe: naiveResult.sharpe,
    };
    recordAcceptance("alphacore", acceptance, {
      stress_summary: v2BacktestSummaries,
      live_summary: liveSummary,
    });

    return NextResponse.json({
      ok: true,
      acceptance,
      stress_results: stressResults,
      live_summary: liveSummary,
      v2_curve: v2Live.daily_nav.map((p) => ({
        date: new Date(p.ts_ms).toISOString().slice(0, 10),
        nav_usd: p.nav_usd,
      })),
      regime_trace: v2Live.regime_trace.map((r) => ({
        date: new Date(r.ts_ms).toISOString().slice(0, 10),
        regime: r.regime,
        breaker: r.breaker,
      })),
      windows_evaluated: windows.length,
      random_windows_used: RANDOM_WINDOWS,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function loadAllSeries(): Map<string, DailyBar[]> {
  const conn = db();
  const rows = conn
    .prepare<
      [],
      {
        asset_id: string;
        date: string;
        open: number;
        high: number;
        low: number;
        close: number;
      }
    >(
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
    bars.push({ ...r, ts_ms: ts });
  }
  return series;
}

function computeBtcMaxDD(
  bars: DailyBar[],
  start_ms: number,
  end_ms: number,
): number {
  const slice = bars.filter((b) => b.ts_ms >= start_ms && b.ts_ms <= end_ms);
  if (slice.length < 2) return 0;
  let peak = slice[0].close;
  let maxDD = 0;
  for (const b of slice) {
    if (b.close > peak) peak = b.close;
    const dd = peak > 0 ? (b.close - peak) / peak : 0;
    if (dd < maxDD) maxDD = dd;
  }
  return Math.round(maxDD * 1000) / 10;
}

function computeBtcLiveSummary(
  bars: DailyBar[],
  start_ms: number,
  end_ms: number,
): { return_pct: number; max_dd_pct: number } {
  const slice = bars.filter((b) => b.ts_ms >= start_ms && b.ts_ms <= end_ms);
  if (slice.length < 2) return { return_pct: 0, max_dd_pct: 0 };
  const ret = ((slice[slice.length - 1].close - slice[0].close) / slice[0].close) * 100;
  return {
    return_pct: Math.round(ret * 10) / 10,
    max_dd_pct: computeBtcMaxDD(bars, start_ms, end_ms),
  };
}

function computeBtcSharpe(
  bars: DailyBar[],
  start_ms: number,
  end_ms: number,
): { sharpe: number | null; ret_pct: number } {
  const slice = bars.filter((b) => b.ts_ms >= start_ms && b.ts_ms <= end_ms);
  if (slice.length < 2) return { sharpe: null, ret_pct: 0 };
  const ret = ((slice[slice.length - 1].close - slice[0].close) / slice[0].close) * 100;
  const logRets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1].close > 0 && slice[i].close > 0) {
      logRets.push(Math.log(slice[i].close / slice[i - 1].close));
    }
  }
  if (logRets.length < 2) return { sharpe: null, ret_pct: Math.round(ret * 10) / 10 };
  const mean = logRets.reduce((s, x) => s + x, 0) / logRets.length;
  const variance = logRets.reduce((s, x) => s + (x - mean) ** 2, 0) / logRets.length;
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : null;
  return {
    sharpe: sharpe != null ? Math.round(sharpe * 100) / 100 : null,
    ret_pct: Math.round(ret * 10) / 10,
  };
}

function pickStressWindows(btcBars: DailyBar[]): Window[] {
  const windows: Window[] = [];
  const n = btcBars.length;

  // ── Two worst-drawdown 60d windows
  // Score each candidate window by its peak-to-trough drawdown.
  const scored: Array<{ start: number; dd: number }> = [];
  for (let i = 0; i + WINDOW_DAYS - 1 < n; i++) {
    const slice = btcBars.slice(i, i + WINDOW_DAYS);
    let peak = slice[0].close;
    let dd = 0;
    for (const b of slice) {
      if (b.close > peak) peak = b.close;
      const ddHere = peak > 0 ? (b.close - peak) / peak : 0;
      if (ddHere < dd) dd = ddHere;
    }
    scored.push({ start: i, dd });
  }
  scored.sort((a, b) => a.dd - b.dd); // worst first
  const used = new Set<number>();
  let added = 0;
  for (const s of scored) {
    if (added >= 2) break;
    // Skip if too close to a window we already added (overlap < 14d)
    let tooClose = false;
    for (const u of used) {
      if (Math.abs(u - s.start) < 14) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    used.add(s.start);
    const startBar = btcBars[s.start];
    const endBar = btcBars[s.start + WINDOW_DAYS - 1];
    windows.push({
      label: `Worst DD #${added + 1}`,
      start_ms: startBar.ts_ms,
      end_ms: endBar.ts_ms,
      start_date: startBar.date,
      end_date: endBar.date,
      source: "fixed_drawdown",
    });
    added++;
  }

  // ── Most recent window
  if (n >= WINDOW_DAYS) {
    const startIdx = n - WINDOW_DAYS;
    used.add(startIdx);
    windows.push({
      label: "Recent 60d",
      start_ms: btcBars[startIdx].ts_ms,
      end_ms: btcBars[n - 1].ts_ms,
      start_date: btcBars[startIdx].date,
      end_date: btcBars[n - 1].date,
      source: "fixed_recent",
    });
  }

  // ── 5 deterministic-random additional 60d windows (overfitting check).
  // Uses a fixed seed so results are reproducible across runs.
  const validStarts: number[] = [];
  for (let i = 0; i + WINDOW_DAYS - 1 < n; i++) validStarts.push(i);
  const rng = mulberry32(RNG_SEED);
  const picks = new Set<number>(used);
  let attempts = 0;
  while (windows.length < 3 + RANDOM_WINDOWS && attempts < 200 && validStarts.length > 0) {
    const idx = Math.floor(rng() * validStarts.length);
    const start = validStarts[idx];
    attempts++;
    let tooClose = false;
    for (const p of picks) {
      if (Math.abs(p - start) < 14) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    picks.add(start);
    const sBar = btcBars[start];
    const eBar = btcBars[start + WINDOW_DAYS - 1];
    windows.push({
      label: `Random ${windows.length - 2}`,
      start_ms: sBar.ts_ms,
      end_ms: eBar.ts_ms,
      start_date: sBar.date,
      end_date: eBar.date,
      source: "random",
    });
  }

  return windows;
}

function regimeBreakdown(
  trace: Array<{ regime: string; breaker: string }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of trace) {
    out[t.regime] = (out[t.regime] ?? 0) + 1;
    if (t.breaker !== "normal") {
      out[`breaker_${t.breaker}`] = (out[`breaker_${t.breaker}`] ?? 0) + 1;
    }
  }
  return out;
}

/** Mulberry32 PRNG — small, fast, deterministic. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
