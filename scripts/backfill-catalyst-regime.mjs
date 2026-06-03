#!/usr/bin/env node
/**
 * Backfill the BTC regime snapshot onto each row of historical_catalysts.
 *
 * For every catalyst, look at BTC hourly klines for the trailing 90 days
 * before the event, compute the same regime triplet the live classifier
 * produces (trend / drawdown / RSI / 30d return), and write it back.
 *
 * Why precompute: the agent tool `query_similar_catalyst` wants to answer
 * "how did past corporate_treasury_buy events perform when BTC was in a
 * down regime?" — recomputing regime per row at query time would mean 362
 * separate trailing-90d window scans on every call. Precomputing makes
 * the filter a single indexed WHERE clause.
 *
 * Run:
 *   node scripts/backfill-catalyst-regime.mjs              # all rows
 *   node scripts/backfill-catalyst-regime.mjs --missing    # only rows without regime yet
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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const missingOnly = process.argv.includes("--missing");

// ─── Make sure regime columns exist ─────────────────────────────────────────
const alters = [
  "ALTER TABLE historical_catalysts ADD COLUMN btc_regime TEXT",
  "ALTER TABLE historical_catalysts ADD COLUMN btc_drawdown_pct REAL",
  "ALTER TABLE historical_catalysts ADD COLUMN btc_rsi_14 REAL",
  "ALTER TABLE historical_catalysts ADD COLUMN btc_return_30d_pct REAL",
];
for (const sql of alters) {
  try { await db.execute(sql); } catch (e) {
    if (!String(e.message).toLowerCase().includes("duplicate")) {
      // Some libSQL builds return a different message; ignore "already exists" silently.
      if (!String(e.message).toLowerCase().includes("already")) {
        console.warn(`  alter warn: ${e.message}`);
      }
    }
  }
}
try { await db.execute("CREATE INDEX IF NOT EXISTS idx_hist_catalysts_regime ON historical_catalysts(btc_regime)"); } catch {}

// ─── Regime compute (mirrors src/lib/regime/classifier.ts) ──────────────────
async function getBtcRegime(ts_ms) {
  const fromMs = ts_ms - 90 * DAY_MS;
  const r = await db.execute({
    sql: `SELECT ts_ms, close, high FROM historical_klines_hourly
          WHERE symbol = 'BTC' AND ts_ms >= ? AND ts_ms <= ?
          ORDER BY ts_ms ASC`,
    args: [fromMs, ts_ms],
  });
  const rows = r.rows.map((x) => ({
    ts_ms: Number(x.ts_ms),
    close: Number(x.close),
    high: Number(x.high),
  }));
  if (rows.length < 48) return null;
  const anchor = rows[rows.length - 1];
  if (Math.abs(anchor.ts_ms - ts_ms) > 36 * HOUR_MS) return null;

  const findCloseAt = (targetMs) => {
    let lo = 0, hi = rows.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].ts_ms <= targetMs) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best === -1 ? null : rows[best].close;
  };
  const past30 = findCloseAt(ts_ms - 30 * DAY_MS);
  const return_30d_pct = past30 && past30 > 0 ? ((anchor.close - past30) / past30) * 100 : null;

  let ath = 0;
  for (const r of rows) if (r.high > ath) ath = r.high;
  const drawdown_pct = ath === 0 ? 0 : ((anchor.close - ath) / ath) * 100;

  // RSI(14) on daily closes (resampled)
  const daily = [];
  let lastBucket = -1;
  for (const r of rows) {
    const bucket = Math.floor(r.ts_ms / DAY_MS);
    if (bucket !== lastBucket) { daily.push(r.close); lastBucket = bucket; }
    else daily[daily.length - 1] = r.close;
  }
  let rsi_14 = 50;
  if (daily.length >= 15) {
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= 14; i++) {
      const ch = daily[i] - daily[i - 1];
      if (ch > 0) avgGain += ch; else avgLoss -= ch;
    }
    avgGain /= 14; avgLoss /= 14;
    for (let i = 15; i < daily.length; i++) {
      const ch = daily[i] - daily[i - 1];
      const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
      avgGain = (avgGain * 13 + g) / 14;
      avgLoss = (avgLoss * 13 + l) / 14;
    }
    rsi_14 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  let trend = "sideways";
  const r30 = return_30d_pct ?? 0;
  if (r30 > 5 && drawdown_pct > -8) trend = "up";
  else if (r30 < -5 && drawdown_pct < -8) trend = "down";

  return {
    trend,
    drawdown_pct: Math.round(drawdown_pct * 100) / 100,
    rsi_14: Math.round(rsi_14 * 10) / 10,
    return_30d_pct: return_30d_pct == null ? null : Math.round(return_30d_pct * 100) / 100,
  };
}

// ─── Walk every catalyst ────────────────────────────────────────────────────
const where = missingOnly ? "WHERE btc_regime IS NULL" : "";
const total = await db.execute(`SELECT COUNT(*) AS n FROM historical_catalysts ${where}`);
const totalCount = Number(total.rows[0].n);
console.log(`Backfilling regime for ${totalCount} catalyst rows…`);

const rows = await db.execute({
  sql: `SELECT id, ts_ms FROM historical_catalysts ${where} ORDER BY ts_ms ASC`,
});

const BATCH = 50;
let done = 0, skipped = 0;
let buf = [];

const flush = async () => {
  if (buf.length === 0) return;
  await db.batch(
    buf.map((b) => ({
      sql: `UPDATE historical_catalysts
            SET btc_regime = ?, btc_drawdown_pct = ?, btc_rsi_14 = ?, btc_return_30d_pct = ?
            WHERE id = ?`,
      args: [b.trend, b.drawdown_pct, b.rsi_14, b.return_30d_pct, b.id],
    })),
    "write",
  );
  buf = [];
};

for (const row of rows.rows) {
  const id = String(row.id);
  const ts_ms = Number(row.ts_ms);
  const reg = await getBtcRegime(ts_ms);
  if (!reg) {
    skipped += 1;
    done += 1;
    continue;
  }
  buf.push({ id, ...reg });
  done += 1;
  if (buf.length >= BATCH) {
    await flush();
    process.stdout.write(`  ${done}/${totalCount}  (skipped ${skipped})\r`);
  }
}
await flush();
console.log(`\nDONE — backfilled ${done - skipped}, skipped ${skipped} (no kline coverage)`);

// ─── Verify distribution ─────────────────────────────────────────────────────
const dist = await db.execute(
  `SELECT btc_regime, COUNT(*) AS n,
          ROUND(AVG(btc_drawdown_pct), 1) AS avg_dd,
          ROUND(AVG(btc_rsi_14), 0) AS avg_rsi
   FROM historical_catalysts
   WHERE btc_regime IS NOT NULL
   GROUP BY btc_regime
   ORDER BY n DESC`,
);
console.log("\nRegime distribution across catalysts:");
for (const row of dist.rows) {
  console.log(`  ${String(row.btc_regime).padEnd(10)}  ${String(row.n).padStart(4)} events   avg dd=${row.avg_dd}%   avg RSI=${row.avg_rsi}`);
}

process.exit(0);
