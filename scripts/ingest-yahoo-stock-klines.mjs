#!/usr/bin/env node
/**
 * Ingest daily OHLC for our 29 tracked stocks + treasuries from
 * Yahoo Finance's free chart endpoint into `klines_daily`.
 *
 * Why: the research / verification / debate agents' price tools
 * (query_asset_history, query_price_around_catalyst) query
 * klines_daily by asset_id. Until this script ran, every stock
 * signal hit "Insufficient data" because we'd only ingested
 * BTC / ETH / SOL.
 *
 * Source: query1.finance.yahoo.com/v8/finance/chart/<ticker>
 * - No API key required
 * - Returns JSON with timestamp + open/high/low/close/volume arrays
 * - 5-year daily window is well within the rate limit
 *
 * Run:
 *   node scripts/ingest-yahoo-stock-klines.mjs            # all 29
 *   node scripts/ingest-yahoo-stock-klines.mjs COIN MSTR  # subset
 */

import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const args = process.argv.slice(2).map((a) => a.toUpperCase());
const tickerFilter = new Set(args);

// Map our asset_id → real Yahoo Finance ticker.
// Most are 1:1 with the symbol; the two unusual ones:
//   - trs-tsla-tr is the same TSLA equity (separate treasury row)
//   - trs-gme / trs-xyz / trs-mstr / trs-tsla → just the ticker
const ASSET_TICKER_MAP = {
  "stk-aapl": "AAPL", "stk-amd": "AMD", "stk-amzn": "AMZN",
  "stk-block": "XYZ",   // Block renamed SQ → XYZ in 2025
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

// ─── Yahoo fetch ────────────────────────────────────────────────────────────
const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";

async function fetchYahooDaily(ticker) {
  // 5y of daily closes — plenty for the agent's 14-day asset_history tool
  // AND for price-around-catalyst lookback on multi-year-old events.
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - 5 * 365 * 24 * 60 * 60;
  const url = `${YAHOO_BASE}${ticker}?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false`;
  // Retry with exponential backoff on rate-limit (Yahoo returns 429 +
  // an HTML "Too Many Requests" body, which trips JSON.parse). Three
  // tries spread across ~70 seconds total is enough to ride out the
  // typical 60s burst window.
  let lastErr;
  for (const wait of [0, 15_000, 45_000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetch(url, {
        headers: {
          // Yahoo's CDN rejects bare fetch UA; needs a browser-like header.
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          "Accept": "application/json,text/plain,*/*",
        },
      });
      if (res.status === 429) {
        lastErr = new Error("Yahoo 429 Too Many Requests");
        continue;
      }
      if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} for ${ticker}`);
      const text = await res.text();
      // If they returned HTML (rate-limit page), JSON.parse will throw.
      // Detect early so the backoff loop can retry.
      if (text.trimStart().startsWith("<") || text.includes("Too Many")) {
        lastErr = new Error("Yahoo returned HTML rate-limit page");
        continue;
      }
      const j = JSON.parse(text);
      return _parseYahooJson(j, ticker);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Yahoo fetch failed with no error");
}

function _parseYahooJson(j, ticker) {  // eslint-disable-line no-unused-vars
  const result = j?.chart?.result?.[0];
  if (!result) {
    throw new Error(
      `No chart data for ${ticker}: ${j?.chart?.error?.description ?? "unknown"}`,
    );
  }
  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0];
  if (!q) throw new Error(`No quote array for ${ticker}`);
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (o == null || c == null) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    rows.push({
      date, open: o, high: h ?? o, low: l ?? o, close: c, volume: v ?? 0,
    });
  }
  return rows;
}

// ─── Upsert into klines_daily ───────────────────────────────────────────────
const UPSERT_SQL = `INSERT INTO klines_daily (asset_id, date, open, high, low, close, volume)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(asset_id, date) DO UPDATE SET
    open = excluded.open, high = excluded.high, low = excluded.low,
    close = excluded.close, volume = excluded.volume`;

async function upsertBatch(assetId, rows) {
  if (rows.length === 0) return 0;
  let upserted = 0;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    await db.batch(
      slice.map((r) => ({
        sql: UPSERT_SQL,
        args: [assetId, r.date, r.open, r.high, r.low, r.close, r.volume],
      })),
      "write",
    );
    upserted += slice.length;
  }
  return upserted;
}

// ─── Main ───────────────────────────────────────────────────────────────────
const assets = await db.execute(
  `SELECT id, symbol, kind FROM assets WHERE kind IN ('stock', 'treasury') ORDER BY symbol`,
);

console.log(`Found ${assets.rows.length} stock + treasury assets in universe`);
console.log(`Pulling 5y daily klines from Yahoo Finance…\n`);

let totalRows = 0;
let okCount = 0;
let failCount = 0;
const failed = [];

for (const row of assets.rows) {
  const assetId = String(row.id);
  const ticker = ASSET_TICKER_MAP[assetId] ?? String(row.symbol).toUpperCase();
  if (tickerFilter.size && !tickerFilter.has(ticker)) continue;

  try {
    const rows = await fetchYahooDaily(ticker);
    const n = await upsertBatch(assetId, rows);
    console.log(
      `  ✓ ${assetId.padEnd(15)} (${ticker.padEnd(6)}) ${String(n).padStart(5)} rows`,
    );
    totalRows += n;
    okCount += 1;
  } catch (err) {
    console.log(`  ✗ ${assetId.padEnd(15)} (${ticker.padEnd(6)}) FAILED: ${(err).message}`);
    failed.push(`${assetId} (${ticker}): ${(err).message}`);
    failCount += 1;
  }
  // Yahoo throttles aggressively — 2s between calls cuts 429s
  // without making the full 29-ticker run egregiously slow (~1 min).
  await new Promise((r) => setTimeout(r, 2_000));
}

console.log(`\nDONE — ${totalRows} total rows across ${okCount} symbols`);
if (failCount > 0) {
  console.log(`Failed: ${failCount}`);
  for (const f of failed) console.log(`  ${f}`);
}

// Verify
const verify = await db.execute(`
  SELECT a.id, a.symbol, COUNT(k.date) AS n, MIN(k.date) AS d_min, MAX(k.date) AS d_max
  FROM assets a LEFT JOIN klines_daily k ON k.asset_id = a.id
  WHERE a.kind IN ('stock', 'treasury')
  GROUP BY a.id, a.symbol
  ORDER BY a.symbol
`);
console.log(`\nVerification (klines_daily counts per asset):`);
for (const row of verify.rows) {
  console.log(
    `  ${String(row.id).padEnd(15)} ${String(row.symbol).padEnd(6)} ${String(row.n).padStart(5)} rows  ${row.d_min ?? "—"} → ${row.d_max ?? "—"}`,
  );
}

process.exit(0);
