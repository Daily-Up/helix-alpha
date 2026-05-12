/**
 * Standalone v2 acceptance run — same logic as the v2-status route,
 * but executed at build time so we can read the result before the
 * server boots. Writes one row to v2_acceptance and prints a
 * human-readable summary.
 */

// Bypass env validation — this script only needs DB access.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
process.env.SOSOVALUE_API_KEY ??= "test";
process.env.ANTHROPIC_API_KEY ??= "test";
process.env.DATABASE_PATH ??= "data/sosoalpha.db";

// Direct DB import to avoid the env-validating client.
import Database from "better-sqlite3";
const dbPath = resolve(process.cwd(), process.env.DATABASE_PATH);
const conn = new Database(dbPath, { readonly: false });
conn.pragma("journal_mode = WAL");

// Import after env shimming
import { _setDatabaseForTests, db } from "../src/lib/db/client";
_setDatabaseForTests(conn);
import { runV2Backtest } from "../src/lib/alphaindex/v2/backtest-v2";
import {
  evaluateAcceptance,
  recordAcceptance,
  type StressWindowResult,
} from "../src/lib/alphaindex/v2/acceptance";
import {
  buildBenchmarkSpec,
  computeBenchmarkSeries,
  type DailyBar,
} from "../src/lib/alphaindex/benchmarks";

const WINDOW_DAYS = 60;
const STARTING_NAV = 10_000;
const RANDOM_WINDOWS = 5;

interface Window {
  label: string;
  start_ms: number;
  end_ms: number;
  start_date: string;
  end_date: string;
  source: "fixed_drawdown" | "fixed_recent" | "random";
}

function loadAllSeries(): Map<string, DailyBar[]> {
  const dbConn = db();
  const rows = dbConn
    .prepare<
      [],
      { asset_id: string; date: string; open: number; high: number; low: number; close: number }
    >(
      `SELECT asset_id, date, open, high, low, close FROM klines_daily ORDER BY asset_id, date ASC`,
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

function computeBtcMaxDD(bars: DailyBar[], start_ms: number, end_ms: number): number {
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

function computeBtcSharpe(bars: DailyBar[], start_ms: number, end_ms: number): { sharpe: number | null; ret_pct: number } {
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

function pickWindows(btcBars: DailyBar[]): Window[] {
  const windows: Window[] = [];
  const n = btcBars.length;
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
  scored.sort((a, b) => a.dd - b.dd);

  const used = new Set<number>();
  let added = 0;
  for (const s of scored) {
    if (added >= 2) break;
    let tooClose = false;
    for (const u of used) if (Math.abs(u - s.start) < 14) { tooClose = true; break; }
    if (tooClose) continue;
    used.add(s.start);
    const sBar = btcBars[s.start];
    const eBar = btcBars[s.start + WINDOW_DAYS - 1];
    windows.push({
      label: `Worst DD #${added + 1}`,
      start_ms: sBar.ts_ms,
      end_ms: eBar.ts_ms,
      start_date: sBar.date,
      end_date: eBar.date,
      source: "fixed_drawdown",
    });
    added++;
  }

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

  const rng = mulberry32(0x517c0de);
  const picks = new Set<number>(used);
  let attempts = 0;
  const validStarts: number[] = [];
  for (let i = 0; i + WINDOW_DAYS - 1 < n; i++) validStarts.push(i);
  while (windows.length < 3 + RANDOM_WINDOWS && attempts < 200 && validStarts.length > 0) {
    const idx = Math.floor(rng() * validStarts.length);
    const start = validStarts[idx];
    attempts++;
    let tooClose = false;
    for (const p of picks) if (Math.abs(p - start) < 14) { tooClose = true; break; }
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

function main() {
  const series = loadAllSeries();
  const btcBars = series.get("tok-btc") ?? [];
  console.log(`[v2-acceptance] BTC kline coverage: ${btcBars.length} days`);
  console.log(`[v2-acceptance] series count: ${series.size} assets`);

  if (btcBars.length < WINDOW_DAYS + 5) {
    console.log("[v2-acceptance] insufficient BTC coverage — aborting.");
    process.exit(1);
  }

  const windows = pickWindows(btcBars);
  console.log(`[v2-acceptance] evaluating ${windows.length} windows`);

  const stressResults: StressWindowResult[] = [];
  console.log("\n=== Stress windows ===");
  console.log(
    "label                      | start      | end        | v2 ret | v2 DD  | btc DD | ratio | v2 SR | btc SR"
  );
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
    const ratio = Math.abs(btcDD) > 0 ? Math.abs(v2.max_drawdown_pct) / Math.abs(btcDD) : 0;
    const v2sStr = v2.sharpe != null ? v2.sharpe.toFixed(2) : "—";
    const btcsStr = btcStats.sharpe != null ? btcStats.sharpe.toFixed(2) : "—";
    console.log(
      `${w.label.padEnd(26)} | ${w.start_date} | ${w.end_date} | ${pad(v2.return_pct.toFixed(1), 6)} | ${pad(v2.max_drawdown_pct.toFixed(1), 6)} | ${pad(btcDD.toFixed(1), 6)} | ${pad(ratio.toFixed(2), 5)} | ${pad(v2sStr, 5)} | ${pad(btcsStr, 5)}`,
    );
  }

  // Live period — last 30d
  const liveStart = btcBars[Math.max(0, btcBars.length - 30)].ts_ms;
  const liveEnd = btcBars[btcBars.length - 1].ts_ms;
  const v2Live = runV2Backtest({
    start_ms: liveStart,
    end_ms: liveEnd,
    series,
    starting_nav: STARTING_NAV,
  });
  const naiveResult = computeBenchmarkSeries({
    spec: buildBenchmarkSpec("naive_momentum_top7"),
    start_ms: liveStart,
    end_ms: liveEnd,
    series,
    starting_nav: STARTING_NAV,
  });

  // BTC buy-and-hold over the same window (for C2 v2.1)
  const btcLiveSlice = btcBars.filter((b) => b.ts_ms >= liveStart && b.ts_ms <= liveEnd);
  const btcLiveRet =
    btcLiveSlice.length >= 2
      ? Math.round(
          (((btcLiveSlice[btcLiveSlice.length - 1].close - btcLiveSlice[0].close) /
            btcLiveSlice[0].close) *
            100) *
            10,
        ) / 10
      : 0;
  let peak = btcLiveSlice[0]?.close ?? 0;
  let btcLiveDD = 0;
  for (const b of btcLiveSlice) {
    if (b.close > peak) peak = b.close;
    const dd = peak > 0 ? (b.close - peak) / peak : 0;
    if (dd < btcLiveDD) btcLiveDD = dd;
  }
  const btcLiveDDPct = Math.round(btcLiveDD * 1000) / 10;

  console.log("\n=== Live period (last 30d) ===");
  console.log(`v2:    return ${v2Live.return_pct}% | max DD ${v2Live.max_drawdown_pct}% | Sharpe ${v2Live.sharpe ?? "—"}`);
  console.log(`BTC:   return ${btcLiveRet}% | max DD ${btcLiveDDPct}%`);
  console.log(`naive: return ${naiveResult.return_pct}% | max DD ${naiveResult.max_drawdown_pct}% | Sharpe ${naiveResult.sharpe ?? "—"}`);

  // Acceptance (v2.1 criteria)
  const acceptance = evaluateAcceptance({
    index_id: "alphacore",
    stress_windows: stressResults,
    v2_live_return_pct: v2Live.return_pct,
    v2_live_max_dd_pct: v2Live.max_drawdown_pct,
    btc_live_return_pct: btcLiveRet,
    btc_live_max_dd_pct: btcLiveDDPct,
    naive_live_return_pct: naiveResult.return_pct,
  });

  console.log("\n=== Acceptance ===");
  const marginalCount = acceptance.criteria.filter((c) => c.status === "marginal").length;
  const passedCount = acceptance.criteria.filter((c) => c.status === "pass").length;
  const summary = acceptance.passed
    ? `PASSED (${passedCount} PASS, ${marginalCount} MARGINAL PASS)`
    : "FAILED";
  console.log(`OVERALL: ${summary}`);
  for (const c of acceptance.criteria) {
    const tag = c.status === "pass" ? "PASS" : c.status === "marginal" ? "MARG" : "FAIL";
    console.log(`  [${tag}] ${c.label}`);
    console.log(`         observed=${c.observed} threshold=${c.threshold} — ${c.detail}`);
    if (c.marginal_note) console.log(`         note: ${c.marginal_note}`);
  }

  // Persist
  recordAcceptance("alphacore", acceptance, {
    stress_summary: stressResults,
    live_summary: {
      v2_return_pct: v2Live.return_pct,
      v2_max_dd_pct: v2Live.max_drawdown_pct,
      v2_sharpe: v2Live.sharpe,
      btc_return_pct: btcLiveRet,
      btc_max_dd_pct: btcLiveDDPct,
      naive_return_pct: naiveResult.return_pct,
    },
  });
  console.log("\n[v2-acceptance] persisted to v2_acceptance table.");
}

function pad(s: string, n: number): string {
  return s.padStart(n);
}

main();
