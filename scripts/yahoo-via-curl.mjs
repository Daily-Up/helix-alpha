#!/usr/bin/env node
/**
 * Fallback: use `curl` subprocess instead of Node's `fetch`.
 *
 * Yahoo's edge appears to apply stricter rate-limit / TLS-fingerprint
 * checks to Node's built-in `fetch` than to `curl` — even when both
 * carry the same User-Agent. After the main script (which uses fetch)
 * hits a wall on the same 9 tickers, this script reliably succeeds.
 *
 * Run:
 *   node scripts/yahoo-via-curl.mjs COIN MSTR XYZ GME CRCL CIFR TSLA
 */

import { spawnSync } from "node:child_process";
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

const ASSET_TICKER_MAP = {
  "stk-block": "XYZ", "stk-cifr": "CIFR", "stk-coin": "COIN",
  "stk-crcl": "CRCL", "trs-gme": "GME", "trs-mstr": "MSTR",
  "stk-tsla": "TSLA", "trs-tsla": "TSLA", "trs-tsla-tr": "TSLA",
  "trs-xyz": "XYZ",
};

function fetchViaCurl(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=2y&interval=1d`;
  const res = spawnSync(
    "curl",
    [
      "-sS",
      "-H", "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
      "-H", "Accept: application/json,text/plain,*/*",
      "-H", "Accept-Language: en-US,en;q=0.9",
      "--connect-timeout", "10",
      "--max-time", "30",
      url,
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`curl exit ${res.status}: ${res.stderr}`);
  const text = res.stdout;
  if (!text || text.trimStart().startsWith("<") || text.includes("Too Many")) {
    throw new Error("Yahoo HTML rate-limit page");
  }
  const j = JSON.parse(text);
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data for ${ticker}`);
  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0];
  if (!q) throw new Error("No quote array");
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (o == null || c == null) continue;
    rows.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: o, high: h ?? o, low: l ?? o, close: c, volume: v ?? 0,
    });
  }
  return rows;
}

const UPSERT_SQL = `INSERT INTO klines_daily (asset_id, date, open, high, low, close, volume)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(asset_id, date) DO UPDATE SET
    open = excluded.open, high = excluded.high, low = excluded.low,
    close = excluded.close, volume = excluded.volume`;

async function upsertBatch(assetId, rows) {
  if (rows.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500);
    await db.batch(
      slice.map((r) => ({
        sql: UPSERT_SQL,
        args: [assetId, r.date, r.open, r.high, r.low, r.close, r.volume],
      })),
      "write",
    );
    n += slice.length;
  }
  return n;
}

const args = process.argv.slice(2).map((s) => s.toUpperCase());
const filter = new Set(args);

const assets = await db.execute(
  `SELECT id, symbol, kind FROM assets WHERE kind IN ('stock', 'treasury') ORDER BY symbol`,
);

let total = 0;
for (const row of assets.rows) {
  const assetId = String(row.id);
  const ticker = ASSET_TICKER_MAP[assetId] ?? String(row.symbol).toUpperCase();
  if (filter.size && !filter.has(ticker)) continue;
  try {
    const rows = fetchViaCurl(ticker);
    const n = await upsertBatch(assetId, rows);
    console.log(`  ✓ ${assetId.padEnd(15)} (${ticker.padEnd(6)}) ${String(n).padStart(5)} rows`);
    total += n;
  } catch (err) {
    console.log(`  ✗ ${assetId.padEnd(15)} (${ticker.padEnd(6)}) FAILED: ${err.message}`);
  }
  // 1.5s between curl calls — curl seems to clear the per-IP budget faster than fetch
  await new Promise((r) => setTimeout(r, 1500));
}

console.log(`\nTotal: ${total} rows`);

const verify = await db.execute(`
  SELECT a.symbol, COUNT(k.date) AS n
  FROM assets a LEFT JOIN klines_daily k ON k.asset_id = a.id
  WHERE a.kind IN ('stock', 'treasury')
  GROUP BY a.id, a.symbol ORDER BY n DESC, a.symbol
`);
console.log(`\nFinal counts:`);
for (const row of verify.rows) {
  if (Number(row.n) === 0) {
    console.log(`  ${String(row.symbol).padEnd(8)} 0 rows`);
  }
}
const zero = verify.rows.filter((r) => Number(r.n) === 0).length;
const ok = verify.rows.length - zero;
console.log(`\n${ok}/${verify.rows.length} symbols populated, ${zero} still empty`);

process.exit(0);
