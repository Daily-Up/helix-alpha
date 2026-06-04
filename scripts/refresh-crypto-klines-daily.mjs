#!/usr/bin/env node
/**
 * Refresh klines_daily for the crypto assets (tok-btc, tok-eth,
 * tok-sol) by aggregating from historical_klines_hourly.
 *
 * Why: query_price_around_catalyst + query_asset_history both read
 * klines_daily by asset_id. Without this refresh, every signal on a
 * crypto asset whose catalyst is fresh (last ~3 weeks) returns
 * 'Limited data' for the price tools — because klines_daily hasn't
 * been re-ingested since we started populating historical_klines_
 * hourly. The hourly table is current (cron-ingested), the daily
 * table was not.
 *
 * Approach: pure SQL aggregation. Group hourly candles by UTC date,
 * derive OHLCV (open=first, high=max, low=min, close=last, volume=sum),
 * upsert into klines_daily. No external API required.
 *
 * Run:
 *   node scripts/refresh-crypto-klines-daily.mjs
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

const SYMBOL_TO_ASSET_ID = {
  BTC: "tok-btc",
  ETH: "tok-eth",
  SOL: "tok-sol",
};

const UPSERT_SQL = `INSERT INTO klines_daily (asset_id, date, open, high, low, close, volume)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(asset_id, date) DO UPDATE SET
    open = excluded.open, high = excluded.high, low = excluded.low,
    close = excluded.close, volume = excluded.volume`;

for (const [symbol, assetId] of Object.entries(SYMBOL_TO_ASSET_ID)) {
  console.log(`Aggregating ${symbol} → ${assetId}…`);

  // Pull last 200 days of hourly candles. Turso has a result-size limit
  // so we cap to 200d (≈ 4800 rows) which is more than enough — the
  // tool window is typically 3 days around a catalyst, never years.
  const cutoffMs = Date.now() - 200 * 24 * 60 * 60 * 1000;
  const r = await db.execute({
    sql: `SELECT ts_ms, open, high, low, close, volume
          FROM historical_klines_hourly
          WHERE symbol = ? AND ts_ms >= ?
          ORDER BY ts_ms ASC`,
    args: [symbol, cutoffMs],
  });

  // Group by UTC date.
  const byDate = new Map();
  for (const row of r.rows) {
    const ts = Number(row.ts_ms);
    const date = new Date(ts).toISOString().slice(0, 10);
    let bucket = byDate.get(date);
    if (!bucket) {
      bucket = {
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      };
      byDate.set(date, bucket);
    } else {
      bucket.high = Math.max(bucket.high, Number(row.high));
      bucket.low = Math.min(bucket.low, Number(row.low));
      bucket.close = Number(row.close); // last hour of the day
      bucket.volume += Number(row.volume);
    }
  }

  console.log(`  ${byDate.size} daily candles`);

  // Upsert in batches of 100.
  const rows = [...byDate.entries()].map(([date, b]) => ({ date, ...b }));
  for (let i = 0; i < rows.length; i += 100) {
    const slice = rows.slice(i, i + 100);
    await db.batch(
      slice.map((r) => ({
        sql: UPSERT_SQL,
        args: [assetId, r.date, r.open, r.high, r.low, r.close, r.volume],
      })),
      "write",
    );
  }
}

// Verify
console.log(`\nVerification (klines_daily after refresh):`);
for (const assetId of Object.values(SYMBOL_TO_ASSET_ID)) {
  const r = await db.execute({
    sql: "SELECT COUNT(*) AS n, MAX(date) AS d_max FROM klines_daily WHERE asset_id = ?",
    args: [assetId],
  });
  console.log(`  ${assetId.padEnd(10)} ${r.rows[0].n} rows, latest = ${r.rows[0].d_max}`);
}

process.exit(0);
