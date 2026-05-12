/**
 * GET /api/data/alphaindex/stress-tests
 *
 * Runs the historical replay (Part 1) for 3 auto-discovered windows
 * from BTC klines (2 worst-drawdown + 1 most-recent). Each window is
 * memoized, so subsequent requests are sub-100ms even on cold cache.
 *
 * Zero-news mode — see backtest.ts JSDoc.
 */

import { NextResponse } from "next/server";
import {
  discoverReplayPeriods,
  runHistoricalReplay,
} from "@/lib/alphaindex/replay-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const t0 = Date.now();
  const periods = discoverReplayPeriods();
  if (periods.length === 0) {
    return NextResponse.json({
      ok: false,
      error:
        "Insufficient BTC kline coverage to run any 60-day replay window (need >=60 daily bars).",
      replays: [],
      latency_ms: Date.now() - t0,
    });
  }
  const replays = periods.map((p) =>
    runHistoricalReplay(p.start_date, p.end_date, p.label),
  );
  return NextResponse.json({
    ok: true,
    note:
      "Replays run in zero-news mode (signals=0). Live strategy includes news-signal boosts which are NOT reflected here.",
    coverage_days: replays[0]?.result.daily_nav.length ?? 0,
    replays: replays.map((r) => ({
      start_date: r.start_date,
      end_date: r.end_date,
      label: r.label,
      hypothesis:
        periods.find((p) => p.start_date === r.start_date)?.hypothesis ?? "",
      notes: r.notes ?? null,
      sample_days: r.result.daily_nav.length,
      rebalance_count: r.result.rebalance_count,
      // Strategy metrics
      return_pct: r.metrics.return_pct,
      max_drawdown_pct: r.metrics.max_drawdown_pct,
      sharpe: r.metrics.sharpe,
      alpha_vs_btc_pct: r.metrics.alpha_vs_btc_pct,
      // BTC baseline metrics
      btc_metrics: btcMetrics(r.btc_nav),
      // Curves: AlphaCore + BTC, normalized to 100
      curve: r.result.daily_nav.map((p, i) => ({
        date: new Date(p.ts_ms).toISOString().slice(0, 10),
        alphacore: i === 0 ? 100 : (p.nav_usd / r.result.daily_nav[0].nav_usd) * 100,
        btc:
          r.btc_nav[i] && r.btc_nav[0]
            ? (r.btc_nav[i].nav_usd / r.btc_nav[0].nav_usd) * 100
            : null,
      })),
    })),
    latency_ms: Date.now() - t0,
  });
}

function btcMetrics(nav: Array<{ ts_ms: number; nav_usd: number }>) {
  if (nav.length < 2) {
    return { return_pct: 0, max_drawdown_pct: 0 };
  }
  const start = nav[0].nav_usd;
  const end = nav[nav.length - 1].nav_usd;
  const ret = start > 0 ? ((end - start) / start) * 100 : 0;
  let peak = nav[0].nav_usd;
  let maxDD = 0;
  for (const n of nav) {
    if (n.nav_usd > peak) peak = n.nav_usd;
    const dd = peak > 0 ? (n.nav_usd - peak) / peak : 0;
    if (dd < maxDD) maxDD = dd;
  }
  return {
    return_pct: Math.round(ret * 10) / 10,
    max_drawdown_pct: Math.round(maxDD * 1000) / 10,
  };
}
