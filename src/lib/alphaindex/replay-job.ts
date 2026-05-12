/**
 * Replay job — Part 1.
 *
 * Loads `klines_daily` for the AlphaIndex universe and runs the
 * `walkPriceSeries` backtest for a given (start, end) window. Used by
 * the `/api/data/alphaindex/stress-tests` route to compute on-demand
 * results for the UI.
 *
 * Memoized in-memory: identical (start, end) pairs return the cached
 * result for the lifetime of the process. Cleared if the underlying
 * klines table changes (we don't detect this — operators can call the
 * cron tick which re-imports the module).
 */

import { db } from "@/lib/db";
import {
  walkPriceSeries,
  computeRunMetrics,
  type DailyBar,
  type ReplayResult,
} from "./backtest";

/** Anchor universe used by the replay. Mirrors the live engine's
 *  ANCHOR_WEIGHTS. Hard-coded here to keep the replay decoupled from
 *  any future change to live anchors (those would invalidate the
 *  historical series anyway). */
const REPLAY_ANCHORS: Record<string, number> = {
  "tok-btc": 0.28,
  "tok-eth": 0.16,
  "tok-sol": 0.07,
  "tok-bnb": 0.05,
  "rwa-xaut": 0.07,
  "idx-ssimag7": 0.07,
  "tok-xrp": 0.03,
  "tok-link": 0.03,
};

const memo = new Map<string, RunHistoricalReplayResult>();

export interface RunHistoricalReplayResult {
  start_date: string; // YYYY-MM-DD
  end_date: string;
  /** Window characterization the UI surfaces. */
  label: string;
  result: ReplayResult;
  /** BTC-only NAV series for the same window — comparison baseline. */
  btc_nav: Array<{ ts_ms: number; nav_usd: number }>;
  /** Computed metrics with vs-BTC alpha. */
  metrics: ReturnType<typeof computeRunMetrics>;
  /** Set when historical coverage was insufficient. */
  notes?: string;
}

/**
 * Run the replay for a date window. Both dates are YYYY-MM-DD UTC.
 *
 * NOTE — zero-news mode: this replay forces signals = 0. See
 * `backtest.ts` JSDoc for the full caveat. The UI labels every replay
 * accordingly.
 */
export function runHistoricalReplay(
  startDate: string,
  endDate: string,
  label: string,
): RunHistoricalReplayResult {
  const cacheKey = `${startDate}|${endDate}`;
  const cached = memo.get(cacheKey);
  if (cached) return cached;

  const startMs = Date.UTC(
    Number(startDate.slice(0, 4)),
    Number(startDate.slice(5, 7)) - 1,
    Number(startDate.slice(8, 10)),
  );
  const endMs = Date.UTC(
    Number(endDate.slice(0, 4)),
    Number(endDate.slice(5, 7)) - 1,
    Number(endDate.slice(8, 10)),
  );

  const series = loadAnchorSeries(REPLAY_ANCHORS, startMs, endMs);
  let notes: string | undefined;

  // If BTC has no data for the window we can't even produce a baseline.
  const btcBars = series.get("tok-btc");
  if (!btcBars || btcBars.length < 30) {
    notes = `Insufficient BTC kline coverage for ${startDate}..${endDate} (need >=30 bars; have ${btcBars?.length ?? 0})`;
  }

  const result = walkPriceSeries({
    start_ms: startMs,
    end_ms: endMs,
    series,
    anchors: REPLAY_ANCHORS,
    starting_nav: 10_000,
    rebalance_freq_days: 7,
  });

  // BTC-only buy-and-hold for the same window (used as alpha baseline).
  const btcNavs = computeBtcBuyHold(btcBars ?? [], 10_000);
  const metrics = computeRunMetrics(result.daily_nav, btcNavs);

  const out: RunHistoricalReplayResult = {
    start_date: startDate,
    end_date: endDate,
    label,
    result,
    btc_nav: btcNavs,
    metrics,
    notes,
  };
  memo.set(cacheKey, out);
  return out;
}

/** Pull klines_daily for each anchor asset, restricted to the window. */
function loadAnchorSeries(
  anchors: Record<string, number>,
  startMs: number,
  endMs: number,
): Map<string, DailyBar[]> {
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  const endDate = new Date(endMs).toISOString().slice(0, 10);
  const out = new Map<string, DailyBar[]>();

  interface Row {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
  }
  for (const assetId of Object.keys(anchors)) {
    const rows = db()
      .prepare<[string, string, string], Row>(
        `SELECT date, open, high, low, close FROM klines_daily
         WHERE asset_id = ? AND date >= ? AND date <= ?
         ORDER BY date ASC`,
      )
      .all(assetId, startDate, endDate);
    out.set(
      assetId,
      rows.map((r) => ({
        asset_id: assetId,
        date: r.date,
        ts_ms: Date.UTC(
          Number(r.date.slice(0, 4)),
          Number(r.date.slice(5, 7)) - 1,
          Number(r.date.slice(8, 10)),
        ),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
      })),
    );
  }
  return out;
}

function computeBtcBuyHold(
  bars: DailyBar[],
  startingNav: number,
): Array<{ ts_ms: number; nav_usd: number }> {
  if (bars.length === 0) return [];
  const startPx = bars[0].close;
  const units = startingNav / startPx;
  return bars.map((b) => ({ ts_ms: b.ts_ms, nav_usd: units * b.close }));
}

/**
 * Pre-baked replay periods. We discover the 3 most-extreme/most-flat
 * 60-day windows from the BTC klines table and label them. Available
 * data may not include a >20% drawdown — the UI surfaces the actual
 * max DD per window so users see what we tested against.
 */
export interface ReplaySpec {
  start_date: string;
  end_date: string;
  label: string;
  hypothesis: string;
}

/**
 * Returns 3 replay specs based on BTC klines. Picks the worst-drawdown
 * window, a different drawdown window (offset start), and the most
 * recent 60d window (typically chop or run-up). When data is too thin
 * for distinct windows, returns whatever we have with a note.
 */
export function discoverReplayPeriods(): ReplaySpec[] {
  interface Row {
    date: string;
    close: number;
  }
  const closes = db()
    .prepare<[], Row>(
      `SELECT date, close FROM klines_daily
       WHERE asset_id = 'tok-btc'
       ORDER BY date ASC`,
    )
    .all();
  if (closes.length < 60) return [];

  const W = 60;
  interface WindowStat {
    start: string;
    end: string;
    ret_pct: number;
    max_dd_pct: number;
    range_pct: number;
  }
  const windows: WindowStat[] = [];
  for (let i = 0; i + W <= closes.length; i++) {
    const sub = closes.slice(i, i + W);
    let peak = sub[0].close;
    let maxDD = 0;
    for (const r of sub) {
      if (r.close > peak) peak = r.close;
      const dd = peak > 0 ? (r.close - peak) / peak : 0;
      if (dd < maxDD) maxDD = dd;
    }
    const ret =
      sub[0].close > 0
        ? (sub[sub.length - 1].close - sub[0].close) / sub[0].close
        : 0;
    const high = Math.max(...sub.map((r) => r.close));
    const low = Math.min(...sub.map((r) => r.close));
    const range = sub[0].close > 0 ? (high - low) / sub[0].close : 0;
    windows.push({
      start: sub[0].date,
      end: sub[sub.length - 1].date,
      ret_pct: ret * 100,
      max_dd_pct: maxDD * 100,
      range_pct: range * 100,
    });
  }

  // Worst drawdown
  const drawdown1 = windows
    .slice()
    .sort((a, b) => a.max_dd_pct - b.max_dd_pct)[0];
  // Different start: worst-drawdown window starting at least 14 days later
  const drawdown2Candidates = windows
    .filter((w) => Date.parse(w.start) - Date.parse(drawdown1.start) >= 14 * 24 * 3600 * 1000)
    .sort((a, b) => a.max_dd_pct - b.max_dd_pct);
  const drawdown2 = drawdown2Candidates[0] ?? windows[Math.floor(windows.length / 2)];
  // Most recent 60d (likely chop or run-up)
  const recent = windows[windows.length - 1];

  return [
    {
      start_date: drawdown1.start,
      end_date: drawdown1.end,
      label: `Drawdown 1 (max DD ${drawdown1.max_dd_pct.toFixed(1)}%)`,
      hypothesis: "Stress test: how does the framework hold up through the worst available 60-day BTC drawdown?",
    },
    {
      start_date: drawdown2.start,
      end_date: drawdown2.end,
      label: `Drawdown 2 (max DD ${drawdown2.max_dd_pct.toFixed(1)}%)`,
      hypothesis: "Different start window — checks whether DD timing within the window matters.",
    },
    {
      start_date: recent.start,
      end_date: recent.end,
      label: `Recent 60d (range ${recent.range_pct.toFixed(1)}%, ret ${recent.ret_pct.toFixed(1)}%)`,
      hypothesis: "Most recent 60-day window — typically chop or run-up. Compares framework behavior in benign tape.",
    },
  ];
}

/** Clear the in-process memo. Called from tests. */
export function _clearReplayCache(): void {
  memo.clear();
}
