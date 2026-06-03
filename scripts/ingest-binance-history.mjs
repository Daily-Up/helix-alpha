#!/usr/bin/env node
/**
 * Ingest hourly OHLCV history from Binance public API into Turso.
 *
 * Pulls 1h klines for BTC / ETH / SOL from each asset's earliest available
 * candle (mid-2017 for BTC/ETH, mid-2020 for SOL) to the current hour, and
 * upserts into `historical_klines_hourly`.
 *
 * Volume:
 *   BTC: 2017-08 → today @ 1h    ≈ 74,000 candles
 *   ETH: 2017-08 → today @ 1h    ≈ 74,000 candles
 *   SOL: 2020-08 → today @ 1h    ≈ 46,000 candles
 *   total                         ≈ 194,000 rows  (~10 MB on disk)
 *
 * Why a one-shot .mjs script instead of a Next API route:
 *   - Single-author dataset; running it once is the whole job.
 *   - 200k rows in one shot is too much for a 15s function budget.
 *   - We don't want this on the Vercel cold-start path.
 *
 * Run:
 *   node scripts/ingest-binance-history.mjs                  # default: BTC ETH SOL
 *   node scripts/ingest-binance-history.mjs BTC ETH          # subset
 *   node scripts/ingest-binance-history.mjs --resume         # only fill the gap since last ts
 *
 * Source:
 *   https://api.binance.com/api/v3/klines
 *   Public, no key needed, 1000 candles per call, 1200 req/min weight budget.
 */

import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ─── Env loader (no dotenv dep — we already have one in deps but stay leaner) ─
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  }
}

if (!process.env.TURSO_DATABASE_URL) {
  console.error("TURSO_DATABASE_URL missing in .env.local");
  process.exit(1);
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ─── Config ──────────────────────────────────────────────────────────────────
// symbol → Binance USDT pair + earliest hint (we still ask Binance for the
// actual earliest candle by polling from before the hint).
const ASSETS = {
  BTC: { pair: "BTCUSDT", startMs: Date.UTC(2017, 7, 17) },  // 2017-08-17
  ETH: { pair: "ETHUSDT", startMs: Date.UTC(2017, 7, 17) },
  SOL: { pair: "SOLUSDT", startMs: Date.UTC(2020, 7, 11) },  // 2020-08-11
};

const BATCH_UPSERT = 500;          // libSQL batch size — keeps each tx small
const PAGE_LIMIT = 1000;           // Binance hard cap per /klines call
const INTERVAL = "1h";
const INTERVAL_MS = 60 * 60 * 1000;
const SLEEP_BETWEEN_CALLS_MS = 80; // ~750 calls/min, well under 1200/min weight

// ─── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const resumeMode = args.includes("--resume");
const symbolFilter = args.filter((a) => !a.startsWith("--")).map((s) => s.toUpperCase());
const symbolsToRun = symbolFilter.length > 0
  ? symbolFilter.filter((s) => ASSETS[s])
  : Object.keys(ASSETS);

if (symbolsToRun.length === 0) {
  console.error("No valid symbols. Choices: BTC ETH SOL");
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchKlinesPage(pair, startMs, endMs) {
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", pair);
  url.searchParams.set("interval", INTERVAL);
  url.searchParams.set("startTime", String(startMs));
  url.searchParams.set("endTime", String(endMs));
  url.searchParams.set("limit", String(PAGE_LIMIT));

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url.toString());
      if (res.status === 429 || res.status === 418) {
        // rate-limited — back off heavily and retry
        const wait = (attempt + 1) * 5000;
        console.warn(`  [429] backing off ${wait}ms…`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt === 4) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error("unreachable");
}

async function getLastIngestedTs(symbol) {
  const r = await db.execute({
    sql: "SELECT MAX(ts_ms) AS last_ts FROM historical_klines_hourly WHERE symbol = ?",
    args: [symbol],
  });
  const row = r.rows[0];
  const v = row?.last_ts;
  return typeof v === "number" ? v : v ? Number(v) : null;
}

async function upsertBatch(symbol, candles) {
  if (candles.length === 0) return;
  const sql = `INSERT INTO historical_klines_hourly
    (symbol, ts_ms, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, ts_ms) DO UPDATE SET
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      volume = excluded.volume`;
  await db.batch(
    candles.map((c) => ({
      sql,
      args: [
        symbol,
        c.ts_ms,
        c.open,
        c.high,
        c.low,
        c.close,
        c.volume,
      ],
    })),
    "write",
  );
}

// ─── Per-symbol driver ───────────────────────────────────────────────────────
async function ingestSymbol(symbol) {
  const { pair, startMs: hintStart } = ASSETS[symbol];
  let cursor = hintStart;

  if (resumeMode) {
    const lastTs = await getLastIngestedTs(symbol);
    if (lastTs && lastTs > cursor) {
      cursor = lastTs + INTERVAL_MS;
      console.log(`[${symbol}] resume from ${new Date(cursor).toISOString()}`);
    } else {
      console.log(`[${symbol}] no prior data — full ingest from ${new Date(cursor).toISOString()}`);
    }
  } else {
    console.log(`[${symbol}] full ingest from ${new Date(cursor).toISOString()}`);
  }

  const now = Date.now();
  let totalRows = 0;
  let pages = 0;
  let pendingBuf = [];

  while (cursor < now) {
    // Binance returns candles with open time >= startTime and < endTime.
    // Page-end = cursor + 1000 hours (the API limit).
    const pageEnd = Math.min(cursor + PAGE_LIMIT * INTERVAL_MS, now);
    const raw = await fetchKlinesPage(pair, cursor, pageEnd);
    pages += 1;

    if (!Array.isArray(raw) || raw.length === 0) {
      // No more data — move past the page window and continue. This handles
      // exchange downtime windows or pre-listing periods cleanly.
      cursor = pageEnd + INTERVAL_MS;
      continue;
    }

    for (const k of raw) {
      // Binance kline format:
      // [ openTime, open, high, low, close, volume, closeTime, ... ]
      pendingBuf.push({
        ts_ms: k[0],
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
      });
    }

    // Advance cursor past the last candle we received.
    const lastTs = raw[raw.length - 1][0];
    cursor = lastTs + INTERVAL_MS;

    // Flush in 500-row batches to keep individual txns small.
    while (pendingBuf.length >= BATCH_UPSERT) {
      const slice = pendingBuf.splice(0, BATCH_UPSERT);
      await upsertBatch(symbol, slice);
      totalRows += slice.length;
    }

    if (pages % 10 === 0) {
      const pct = ((cursor - hintStart) / (now - hintStart) * 100).toFixed(1);
      console.log(
        `  [${symbol}] page ${pages}  cursor=${new Date(cursor).toISOString().slice(0, 10)}  +${totalRows} rows  (${pct}%)`,
      );
    }

    await sleep(SLEEP_BETWEEN_CALLS_MS);
  }

  // Final flush
  if (pendingBuf.length > 0) {
    await upsertBatch(symbol, pendingBuf);
    totalRows += pendingBuf.length;
  }

  console.log(`[${symbol}] DONE — ${totalRows} rows over ${pages} pages`);
  return totalRows;
}

// ─── Main ────────────────────────────────────────────────────────────────────
console.log(`Ingesting symbols: ${symbolsToRun.join(", ")}  mode=${resumeMode ? "resume" : "full"}`);
console.log(`Source: Binance public /api/v3/klines  interval=${INTERVAL}`);
console.log("─".repeat(72));

const t0 = Date.now();
let grandTotal = 0;
for (const sym of symbolsToRun) {
  try {
    const n = await ingestSymbol(sym);
    grandTotal += n;
  } catch (err) {
    console.error(`[${sym}] FAILED:`, err.message);
  }
  console.log("─".repeat(72));
}

const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\nINGEST COMPLETE  ${grandTotal} rows  in ${secs}s`);

// Quick verification — show per-symbol counts and date ranges.
const verify = await db.execute({
  sql: `SELECT symbol,
               COUNT(*) AS n,
               MIN(ts_ms) AS first_ts,
               MAX(ts_ms) AS last_ts
        FROM historical_klines_hourly
        GROUP BY symbol
        ORDER BY symbol`,
});
console.log("\nVerification:");
for (const row of verify.rows) {
  const first = new Date(Number(row.first_ts)).toISOString().slice(0, 16);
  const last = new Date(Number(row.last_ts)).toISOString().slice(0, 16);
  console.log(`  ${row.symbol}  ${String(row.n).padStart(7)} rows   ${first}  →  ${last}`);
}

process.exit(0);
