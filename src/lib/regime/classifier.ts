/**
 * Market-regime classifier (Wave 2 — historical context layer).
 *
 * Given (symbol, ts_ms), look at `historical_klines_hourly` and return a
 * compact regime snapshot the agent can reason over:
 *
 *   {
 *     trend          : 'up' | 'down' | 'sideways',
 *     drawdown_pct   : -42.1   // negative = how far below recent ATH
 *     vol_pct        :  3.2    // 30d realized vol, annualized %
 *     rsi_14         : 38.4
 *     days_since_ath : 47
 *     return_30d_pct : -18.6
 *     return_90d_pct : -32.1
 *     close          :  91240,
 *     ts_ms          : 1701432000000
 *   }
 *
 * The agent uses this to short-circuit "long BTC even though it's clearly
 * dumping" failure modes — when trend=down + drawdown<-8% + RSI<40, a
 * fresh LONG signal should be downgraded or killed.
 *
 * The function returns null if there's no kline data within 36h of the
 * target timestamp (asset wasn't priceable). Callers should treat null as
 * "no regime info, default to status quo".
 */

import { all, get } from "@/lib/db/client";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface RegimeSnapshot {
  symbol: string;
  ts_ms: number;
  close: number;
  trend: "up" | "down" | "sideways";
  drawdown_pct: number;       // negative = below recent ATH, 0 = at ATH
  vol_pct: number;             // 30d realized vol, annualized %
  rsi_14: number;              // 0..100, Wilder smoothing
  days_since_ath: number;
  return_30d_pct: number | null;
  return_90d_pct: number | null;
}

interface CandleRow {
  ts_ms: number;
  close: number;
  high: number;
}

/**
 * Compute the regime for `symbol` at `ts_ms`. Defaults to current time when
 * ts_ms is omitted. Returns null if no kline data is available.
 */
export async function getRegime(
  symbol: string,
  ts_ms: number = Date.now(),
): Promise<RegimeSnapshot | null> {
  // Pull the trailing 90d window in candles. 90d × 24h = 2160 rows.
  const fromMs = ts_ms - 90 * DAY_MS;
  const rows = await all<CandleRow>(
    `SELECT ts_ms, close, high
     FROM historical_klines_hourly
     WHERE symbol = ?
       AND ts_ms >= ?
       AND ts_ms <= ?
     ORDER BY ts_ms ASC`,
    [symbol.toUpperCase(), fromMs, ts_ms],
  );

  if (rows.length < 48) {
    // Not enough data (< 2 days) — bail.
    return null;
  }

  // Anchor on the candle nearest (but not after) ts_ms.
  const anchor = rows[rows.length - 1];
  if (Math.abs(anchor.ts_ms - ts_ms) > 36 * HOUR_MS) {
    return null;
  }

  // ── Returns
  const findCloseAt = (targetMs: number): number | null => {
    // Binary search the candle <= targetMs.
    let lo = 0, hi = rows.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].ts_ms <= targetMs) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best === -1 ? null : rows[best].close;
  };
  const ret = (lookbackDays: number): number | null => {
    const past = findCloseAt(ts_ms - lookbackDays * DAY_MS);
    if (past == null || past === 0) return null;
    return ((anchor.close - past) / past) * 100;
  };
  const return_30d_pct = ret(30);
  const return_90d_pct = ret(90);

  // ── Drawdown from rolling 90d ATH
  let ath = 0;
  let athTs = anchor.ts_ms;
  for (const r of rows) {
    if (r.high > ath) { ath = r.high; athTs = r.ts_ms; }
  }
  const drawdown_pct = ath === 0 ? 0 : ((anchor.close - ath) / ath) * 100;
  const days_since_ath = Math.max(0, Math.round((anchor.ts_ms - athTs) / DAY_MS));

  // ── 30d realized volatility (annualized)
  // log returns of hourly closes over trailing 30d.
  const volWindowStart = ts_ms - 30 * DAY_MS;
  const volRows = rows.filter((r) => r.ts_ms >= volWindowStart);
  let sumSq = 0, n = 0;
  for (let i = 1; i < volRows.length; i++) {
    const prev = volRows[i - 1].close;
    const curr = volRows[i].close;
    if (prev > 0 && curr > 0) {
      const lr = Math.log(curr / prev);
      sumSq += lr * lr;
      n += 1;
    }
  }
  // Hourly vol → annualized: × sqrt(24 × 365)
  const vol_pct = n > 0 ? Math.sqrt(sumSq / n) * Math.sqrt(24 * 365) * 100 : 0;

  // ── RSI(14) on daily closes
  // Sample one close per day from the rows.
  const dailyCloses: number[] = [];
  let lastDayBucket = -1;
  for (const r of rows) {
    const bucket = Math.floor(r.ts_ms / DAY_MS);
    if (bucket !== lastDayBucket) {
      dailyCloses.push(r.close);
      lastDayBucket = bucket;
    } else {
      dailyCloses[dailyCloses.length - 1] = r.close; // keep latest in same day
    }
  }
  let rsi_14 = 50;
  if (dailyCloses.length >= 15) {
    let avgGain = 0, avgLoss = 0;
    // Seed with first 14 changes
    for (let i = 1; i <= 14; i++) {
      const change = dailyCloses[i] - dailyCloses[i - 1];
      if (change > 0) avgGain += change;
      else avgLoss -= change;
    }
    avgGain /= 14;
    avgLoss /= 14;
    // Wilder smoothing for the rest
    for (let i = 15; i < dailyCloses.length; i++) {
      const change = dailyCloses[i] - dailyCloses[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;
      avgGain = (avgGain * 13 + gain) / 14;
      avgLoss = (avgLoss * 13 + loss) / 14;
    }
    if (avgLoss === 0) rsi_14 = 100;
    else {
      const rs = avgGain / avgLoss;
      rsi_14 = 100 - 100 / (1 + rs);
    }
  }

  // ── Trend label
  // Heuristic: trend = up when (return_30d > +5% AND drawdown > -8%),
  //            trend = down when (return_30d < -5% AND drawdown < -8%),
  //            sideways otherwise. We deliberately pair magnitude with
  //            drawdown so a -7% pullback inside an uptrend doesn't flip
  //            us to "down".
  let trend: "up" | "down" | "sideways" = "sideways";
  const r30 = return_30d_pct ?? 0;
  if (r30 > 5 && drawdown_pct > -8) trend = "up";
  else if (r30 < -5 && drawdown_pct < -8) trend = "down";

  return {
    symbol: symbol.toUpperCase(),
    ts_ms: anchor.ts_ms,
    close: anchor.close,
    trend,
    drawdown_pct: round(drawdown_pct, 2),
    vol_pct: round(vol_pct, 2),
    rsi_14: round(rsi_14, 1),
    days_since_ath,
    return_30d_pct: return_30d_pct == null ? null : round(return_30d_pct, 2),
    return_90d_pct: return_90d_pct == null ? null : round(return_90d_pct, 2),
  };
}

function round(x: number, dp: number): number {
  const m = Math.pow(10, dp);
  return Math.round(x * m) / m;
}

/**
 * Whether the regime is what we'd call "stress" — counter-trend, deep
 * drawdown, low RSI. Used by the AUTO-tier gate to refuse LONG signals
 * that fire into a falling tape.
 */
export function isStressRegime(r: RegimeSnapshot): boolean {
  return r.trend === "down" && r.drawdown_pct < -8 && r.rsi_14 < 40;
}

/**
 * Latest BTC close, useful as a quick price reference. Returns null if
 * historical_klines_hourly is empty.
 */
export async function getLatestBtcClose(): Promise<number | null> {
  const row = await get<{ close: number }>(
    `SELECT close FROM historical_klines_hourly
     WHERE symbol = 'BTC'
     ORDER BY ts_ms DESC LIMIT 1`,
  );
  return row?.close ?? null;
}
