#!/usr/bin/env node
/**
 * Surgical fix for the remaining "flat 0.00%" outcomes that the
 * generic reprice couldn't touch. Two real causes, two targeted
 * patches:
 *
 *   A. Missing price_at_generation (trs-mstr / stk-coin rows). Klines
 *      ARE available for those assets — the anchor just wasn't
 *      recorded at signal-fire time. Backfill from klines_daily on
 *      the catalyst date, then run the directional close-to-close
 *      math.
 *
 *   B. Missing klines coverage on tok-hype / tok-wlfi. Those tokens
 *      aren't in the BTC/ETH/SOL hourly ingest, and the cron's daily
 *      refresh only covers a curated list. Pull from Binance public
 *      klines (no auth required) and upsert into klines_daily before
 *      repricing.
 *
 *   C. idx-ssidefi (3 rows) is a synthetic in-house index with no
 *      exchange listing — leaving those as flat is correct.
 *
 * After this runs there should be exactly 0 rows with realized_pct=0
 * AND outcome='flat' AND price_at_outcome IS NULL on any priceable
 * asset.
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

const UPSERT_KLINE = `INSERT INTO klines_daily (asset_id, date, open, high, low, close, volume)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(asset_id, date) DO UPDATE SET
    open = excluded.open, high = excluded.high, low = excluded.low,
    close = excluded.close, volume = excluded.volume`;

function dateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// ─── Step B: pull Binance daily klines for tok-hype / tok-wlfi ──────────────
async function refreshBinanceTokenDaily(assetId, binanceSymbol, daysBack = 90) {
  const end = Date.now();
  const start = end - daysBack * 24 * 60 * 60 * 1000;
  const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=1d&startTime=${start}&endTime=${end}&limit=500`;
  console.log(`  fetching ${binanceSymbol} from Binance…`);
  const r = await fetch(url);
  if (!r.ok) {
    console.log(`    Binance HTTP ${r.status} — skipping ${assetId}`);
    return 0;
  }
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log(`    no candles returned — skipping ${assetId}`);
    return 0;
  }
  const batch = rows.map((c) => ({
    sql: UPSERT_KLINE,
    args: [
      assetId,
      new Date(c[0]).toISOString().slice(0, 10),
      parseFloat(c[1]),
      parseFloat(c[2]),
      parseFloat(c[3]),
      parseFloat(c[4]),
      parseFloat(c[5]),
    ],
  }));
  await db.batch(batch, "write");
  console.log(`    upserted ${rows.length} daily candles for ${assetId}`);
  return rows.length;
}

console.log("─── Step B: refresh missing-coverage token klines ───────────────");
await refreshBinanceTokenDaily("tok-hype", "HYPEUSDT");
await refreshBinanceTokenDaily("tok-wlfi", "WLFIUSDT");

// ─── Step A: backfill price_at_generation from klines_daily ─────────────────
async function priceAtOrBefore(assetId, ts) {
  const r = await db.execute({
    sql: `SELECT close FROM klines_daily
          WHERE asset_id = ? AND date <= ?
          ORDER BY date DESC LIMIT 1`,
    args: [assetId, dateStr(ts)],
  });
  const v = r.rows[0]?.close;
  return v != null && Number(v) > 0 ? Number(v) : null;
}

console.log("\n─── Step A: backfill NULL price_at_generation ────────────────");
const nullEntry = await db.execute({
  sql: `SELECT signal_id, asset_id, generated_at
        FROM signal_outcomes
        WHERE outcome = 'flat' AND realized_pct = 0
          AND price_at_generation IS NULL`,
});
let entryFixed = 0;
for (const row of nullEntry.rows) {
  const entry = await priceAtOrBefore(String(row.asset_id), Number(row.generated_at));
  if (entry == null) {
    console.log(`  no kline on/before ${dateStr(Number(row.generated_at))} for ${row.asset_id} — skip`);
    continue;
  }
  await db.execute({
    sql: `UPDATE signal_outcomes SET price_at_generation = ? WHERE signal_id = ?`,
    args: [entry, String(row.signal_id)],
  });
  console.log(`  ${row.asset_id} ${dateStr(Number(row.generated_at))} → entry=${entry}`);
  entryFixed++;
}
console.log(`  backfilled ${entryFixed}/${nullEntry.rows.length} entries`);

// ─── Step C: re-run the directional close-to-close reprice on every
//            zero-flat row we can now resolve ──────────────────────────────
console.log("\n─── Step C: reprice all zero-realized flat outcomes ──────────");
async function klinesForWindow(assetId, fromMs, toMs) {
  const r = await db.execute({
    sql: `SELECT date, open, high, low, close FROM klines_daily
          WHERE asset_id = ? AND date >= ? AND date <= ?
          ORDER BY date ASC`,
    args: [assetId, dateStr(fromMs), dateStr(toMs)],
  });
  return r.rows.map((row) => ({
    date: row.date,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    ts_ms: Date.parse(`${row.date}T00:00:00.000Z`),
  }));
}

function resolveFlat(signal, klines) {
  const { direction, price_at_generation, target_pct, stop_pct, generated_at, expires_at } = signal;
  if (!price_at_generation || price_at_generation <= 0) return null;

  const targetPrice =
    direction === "long"
      ? price_at_generation * (1 + target_pct / 100)
      : price_at_generation * (1 - target_pct / 100);
  const stopPrice =
    direction === "long"
      ? price_at_generation * (1 - stop_pct / 100)
      : price_at_generation * (1 + stop_pct / 100);

  const inWindow = klines.filter((k) => k.ts_ms >= generated_at && k.ts_ms <= expires_at);
  if (inWindow.length === 0) return null;

  for (const bar of inWindow) {
    const targetHit = direction === "long" ? bar.high >= targetPrice : bar.low <= targetPrice;
    const stopHit = direction === "long" ? bar.low <= stopPrice : bar.high >= stopPrice;
    if (targetHit && stopHit) return { outcome: "stop_hit", outcome_at_ms: bar.ts_ms, price_at_outcome: stopPrice, realized_pct: -stop_pct };
    if (targetHit) return { outcome: "target_hit", outcome_at_ms: bar.ts_ms, price_at_outcome: targetPrice, realized_pct: target_pct };
    if (stopHit) return { outcome: "stop_hit", outcome_at_ms: bar.ts_ms, price_at_outcome: stopPrice, realized_pct: -stop_pct };
  }
  const lastBar = inWindow[inWindow.length - 1];
  const rawMove = ((lastBar.close - price_at_generation) / price_at_generation) * 100;
  const directional = direction === "long" ? rawMove : -rawMove;
  return {
    outcome: "flat",
    outcome_at_ms: expires_at,
    price_at_outcome: lastBar.close,
    realized_pct: Number(directional.toFixed(2)),
  };
}

const r = await db.execute({
  sql: `SELECT signal_id, asset_id, direction, target_pct, stop_pct,
               price_at_generation, generated_at, expires_at
        FROM signal_outcomes
        WHERE outcome = 'flat' AND realized_pct = 0`,
});
let updated = 0;
let upgraded = 0;
let stillZero = 0;
let skippedNoEntry = 0;
let skippedNoKlines = 0;

for (const row of r.rows) {
  if (row.price_at_generation == null) {
    skippedNoEntry++;
    continue;
  }
  const klines = await klinesForWindow(
    String(row.asset_id),
    Number(row.generated_at),
    Number(row.expires_at),
  );
  if (klines.length === 0) {
    skippedNoKlines++;
    continue;
  }
  const verdict = resolveFlat(
    {
      direction: String(row.direction),
      price_at_generation: Number(row.price_at_generation),
      target_pct: Number(row.target_pct),
      stop_pct: Number(row.stop_pct),
      generated_at: Number(row.generated_at),
      expires_at: Number(row.expires_at),
    },
    klines,
  );
  if (!verdict) continue;

  const sizeR = await db.execute({
    sql: `SELECT suggested_size_usd AS size FROM signals WHERE id = ?`,
    args: [String(row.signal_id)],
  });
  const sizeUsd = sizeR.rows[0]?.size != null ? Number(sizeR.rows[0].size) : null;
  const pnl = verdict.realized_pct != null && sizeUsd != null
    ? (verdict.realized_pct / 100) * sizeUsd
    : null;

  await db.execute({
    sql: `UPDATE signal_outcomes
          SET outcome = ?, outcome_at = ?, price_at_outcome = ?,
              realized_pct = ?, realized_pnl_usd = ?
          WHERE signal_id = ? AND outcome = 'flat'`,
    args: [
      verdict.outcome,
      verdict.outcome_at_ms,
      verdict.price_at_outcome,
      verdict.realized_pct,
      pnl,
      String(row.signal_id),
    ],
  });
  updated++;
  if (verdict.outcome !== "flat") upgraded++;
  if (verdict.outcome === "flat" && verdict.realized_pct === 0) stillZero++;
  console.log(`  ${row.asset_id} ${row.direction} → ${verdict.outcome} ${verdict.realized_pct?.toFixed?.(2)}%`);
}

console.log(`\nDONE`);
console.log(`  updated:                 ${updated}`);
console.log(`    upgraded to hit:       ${upgraded}`);
console.log(`    legit close-at-entry:  ${stillZero}`);
console.log(`  skipped (no entry):      ${skippedNoEntry}`);
console.log(`  skipped (no klines):     ${skippedNoKlines}`);

process.exit(0);
