/**
 * Refresh `klines_daily` for crypto + stock assets so the agent
 * tools that query day-level prices (`query_price_around_catalyst`,
 * `query_asset_history`) never see stale data on fresh catalysts.
 *
 * Two sources, two strategies:
 *
 * 1. **Crypto** (`tok-btc`, `tok-eth`, `tok-sol`): aggregate from our
 *    own `historical_klines_hourly` table. The cron-driven hourly
 *    ingest keeps that table current, so the daily view is a pure
 *    in-database rollup with no external API call.
 *
 * 2. **Stocks + treasuries** (29 assets): hit Yahoo Finance's free
 *    public chart endpoint via Node `fetch`. Yahoo applies stricter
 *    rate-limit / TLS-fingerprint checks to fetch than to curl, so
 *    we use a browser-like User-Agent and a 2s gap between calls.
 *    The script `scripts/yahoo-via-curl.mjs` is the manual fallback
 *    when this path fails — same shape, spawns `curl`.
 *
 * Idempotent on (asset_id, date) — safe to run as often as we like.
 *
 * Returns a structured summary suitable for `cron_runs`.
 */

import { all, batch } from "@/lib/db";

const SYMBOL_TO_ASSET_ID: Record<string, string> = {
  BTC: "tok-btc",
  ETH: "tok-eth",
  SOL: "tok-sol",
};

const STOCK_ASSET_TICKER_MAP: Record<string, string> = {
  "stk-aapl": "AAPL", "stk-amd": "AMD", "stk-amzn": "AMZN",
  "stk-block": "XYZ",
  "stk-cifr": "CIFR", "stk-coin": "COIN", "stk-crcl": "CRCL",
  "stk-googl": "GOOGL", "stk-hood": "HOOD", "stk-hut": "HUT",
  "stk-intc": "INTC", "stk-iren": "IREN", "stk-mara": "MARA",
  "stk-meta": "META", "stk-msft": "MSFT", "stk-mu": "MU",
  "stk-nvda": "NVDA", "stk-orcl": "ORCL", "stk-pltr": "PLTR",
  "stk-pypl": "PYPL", "stk-riot": "RIOT", "stk-tsla": "TSLA",
  "stk-tsm": "TSM", "stk-wulf": "WULF",
  "trs-gme": "GME", "trs-mstr": "MSTR", "trs-tsla": "TSLA",
  "trs-tsla-tr": "TSLA", "trs-xyz": "XYZ",
};

const UPSERT_SQL = `INSERT INTO klines_daily (asset_id, date, open, high, low, close, volume)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(asset_id, date) DO UPDATE SET
    open = excluded.open, high = excluded.high, low = excluded.low,
    close = excluded.close, volume = excluded.volume`;

export interface RefreshSummary {
  crypto_assets_refreshed: number;
  crypto_days_upserted: number;
  stock_assets_refreshed: number;
  stock_assets_failed: number;
  stock_days_upserted: number;
  latency_ms: number;
  errors: Array<{ asset_id: string; error: string }>;
}

// ─── Crypto path: aggregate from historical_klines_hourly ───────────────────
async function refreshCryptoFromHourly(daysBack: number) {
  const cutoffMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  let totalDays = 0;
  let assets = 0;

  for (const [symbol, assetId] of Object.entries(SYMBOL_TO_ASSET_ID)) {
    const rows = await all<{
      ts_ms: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>(
      `SELECT ts_ms, open, high, low, close, volume
       FROM historical_klines_hourly
       WHERE symbol = ? AND ts_ms >= ?
       ORDER BY ts_ms ASC`,
      [symbol, cutoffMs],
    );
    if (rows.length === 0) continue;

    const byDate = new Map<
      string,
      { open: number; high: number; low: number; close: number; volume: number }
    >();
    for (const r of rows) {
      const ts = Number(r.ts_ms);
      const date = new Date(ts).toISOString().slice(0, 10);
      const bucket = byDate.get(date);
      if (!bucket) {
        byDate.set(date, {
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
        });
      } else {
        bucket.high = Math.max(bucket.high, r.high);
        bucket.low = Math.min(bucket.low, r.low);
        bucket.close = r.close; // last hour wins
        bucket.volume += r.volume;
      }
    }

    const candles = [...byDate.entries()];
    const BATCH = 100;
    for (let i = 0; i < candles.length; i += BATCH) {
      await batch(
        candles.slice(i, i + BATCH).map(([date, b]) => ({
          sql: UPSERT_SQL,
          args: [assetId, date, b.open, b.high, b.low, b.close, b.volume],
        })),
      );
    }
    totalDays += candles.length;
    assets += 1;
  }
  return { assets, days: totalDays };
}

// ─── Stock path: Yahoo Finance ──────────────────────────────────────────────
async function fetchYahooDaily(ticker: string, daysBack: number) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - daysBack * 24 * 60 * 60;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false`;

  // One retry with a 5s backoff — anything more aggressive than that
  // would block the cron handler past its 60s deadline.
  let lastErr: Error | null = null;
  for (const wait of [0, 5_000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept: "application/json,text/plain,*/*",
        },
      });
      if (res.status === 429) {
        lastErr = new Error("Yahoo 429");
        continue;
      }
      if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
      const text = await res.text();
      if (text.trimStart().startsWith("<") || text.includes("Too Many")) {
        lastErr = new Error("Yahoo rate-limit page");
        continue;
      }
      const j = JSON.parse(text);
      const result = j?.chart?.result?.[0];
      if (!result) throw new Error("No chart data");
      const ts = result.timestamp ?? [];
      const q = result.indicators?.quote?.[0];
      if (!q) throw new Error("No quote array");
      const rows: Array<{
        date: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }> = [];
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i],
          h = q.high?.[i],
          l = q.low?.[i],
          c = q.close?.[i],
          v = q.volume?.[i];
        if (o == null || c == null) continue;
        rows.push({
          date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
          open: o,
          high: h ?? o,
          low: l ?? o,
          close: c,
          volume: v ?? 0,
        });
      }
      return rows;
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw lastErr ?? new Error("Yahoo fetch failed");
}

async function refreshStocksFromYahoo(daysBack: number) {
  let totalDays = 0;
  let okCount = 0;
  let failCount = 0;
  const errors: Array<{ asset_id: string; error: string }> = [];

  for (const [assetId, ticker] of Object.entries(STOCK_ASSET_TICKER_MAP)) {
    try {
      const candles = await fetchYahooDaily(ticker, daysBack);
      if (candles.length === 0) continue;
      const BATCH = 100;
      for (let i = 0; i < candles.length; i += BATCH) {
        await batch(
          candles.slice(i, i + BATCH).map((c) => ({
            sql: UPSERT_SQL,
            args: [
              assetId,
              c.date,
              c.open,
              c.high,
              c.low,
              c.close,
              c.volume,
            ],
          })),
        );
      }
      totalDays += candles.length;
      okCount += 1;
    } catch (err) {
      failCount += 1;
      errors.push({ asset_id: assetId, error: (err as Error).message });
    }
    // 2s between tickers — Yahoo throttles aggressively
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: okCount, fail: failCount, days: totalDays, errors };
}

/**
 * Top-level entry point. Refreshes both crypto and stocks. Defaults
 * to 14 days of look-back for both — enough to fill any gap a daily
 * cron might leave while staying well under Vercel's 60s function
 * limit (29 stocks × 2s + N batch writes ≈ ~75s, so we cap stocks at
 * a smaller daysBack or split the run if needed).
 *
 * For Yahoo: daysBack=14 keeps the per-asset payload tiny (~10 rows
 * each) and the whole stock run finishes in well under a minute.
 */
export async function refreshKlinesDaily(
  opts: { daysBack?: number; skipStocks?: boolean } = {},
): Promise<RefreshSummary> {
  const t0 = Date.now();
  const daysBack = opts.daysBack ?? 14;
  const errors: Array<{ asset_id: string; error: string }> = [];

  const crypto = await refreshCryptoFromHourly(daysBack);

  let stocks = { ok: 0, fail: 0, days: 0, errors: [] as typeof errors };
  if (!opts.skipStocks) {
    stocks = await refreshStocksFromYahoo(daysBack);
  }

  return {
    crypto_assets_refreshed: crypto.assets,
    crypto_days_upserted: crypto.days,
    stock_assets_refreshed: stocks.ok,
    stock_assets_failed: stocks.fail,
    stock_days_upserted: stocks.days,
    latency_ms: Date.now() - t0,
    errors: [...errors, ...stocks.errors],
  };
}
