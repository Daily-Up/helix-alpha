#!/usr/bin/env node
/**
 * One-off catch-up: pull the missing days of klines_daily directly
 * from Binance (crypto) and Yahoo (stocks), then re-run the flat-
 * outcome reprice for every June 2026 signal whose realized_pct is
 * still missing.
 *
 * Why this exists: the regular klines refresh cron stalled and the
 * daily candle table for tok-btc / tok-eth / stk-coin etc. is several
 * days behind. The performance page shows "FLAT —" for every signal
 * whose expires_at falls in that gap because the resolver has no
 * close-at-expiry to compute against.
 *
 *   node scripts/catch-up-klines-and-reprice.mjs
 */
import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

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

const UPSERT = `INSERT INTO klines_daily (asset_id, date, open, high, low, close, volume)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(asset_id, date) DO UPDATE SET
    open = excluded.open, high = excluded.high, low = excluded.low,
    close = excluded.close, volume = excluded.volume`;

// ─── Crypto: Binance daily candles ─────────────────────────────────
const CRYPTO_MAP = { "tok-btc": "BTCUSDT", "tok-eth": "ETHUSDT", "tok-sol": "SOLUSDT" };
async function fetchBinanceDaily(symbol, days = 30) {
  const end = Date.now();
  const start = end - days * 86400_000;
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&startTime=${start}&endTime=${end}&limit=${days + 2}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance ${symbol} HTTP ${r.status}`);
  return await r.json();
}
console.log("─── Crypto catch-up (Binance) ───");
for (const [assetId, symbol] of Object.entries(CRYPTO_MAP)) {
  try {
    const candles = await fetchBinanceDaily(symbol, 30);
    const batch = candles.map((c) => ({
      sql: UPSERT,
      args: [
        assetId,
        new Date(c[0]).toISOString().slice(0, 10),
        parseFloat(c[1]), parseFloat(c[2]), parseFloat(c[3]),
        parseFloat(c[4]), parseFloat(c[5]),
      ],
    }));
    if (batch.length > 0) {
      await db.batch(batch, "write");
      console.log(`  ${assetId.padEnd(10)} +${candles.length} days from Binance`);
    }
  } catch (err) {
    console.log(`  ${assetId.padEnd(10)} FAILED: ${err.message}`);
  }
}

// ─── Stocks: Yahoo via curl (Node fetch gets rate-limited) ─────────
const STOCK_MAP = {
  "stk-coin": "COIN", "stk-hood": "HOOD", "stk-mara": "MARA",
  "stk-riot": "RIOT", "stk-cifr": "CIFR", "stk-iren": "IREN",
  "stk-tsla": "TSLA", "stk-aapl": "AAPL", "stk-amzn": "AMZN",
  "stk-googl": "GOOGL", "stk-meta": "META", "stk-msft": "MSFT",
  "stk-nvda": "NVDA", "stk-amd": "AMD", "stk-intc": "INTC",
  "stk-mu": "MU", "stk-orcl": "ORCL", "stk-pltr": "PLTR",
  "stk-pypl": "PYPL", "stk-tsm": "TSM", "stk-block": "XYZ",
  "stk-wulf": "WULF", "stk-hut": "HUT",
  "trs-mstr": "MSTR", "trs-tsla": "TSLA", "trs-gme": "GME",
  "trs-tsla-tr": "TSLA", "trs-xyz": "XYZ",
};
function fetchYahooViaCurl(ticker) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - 30 * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${start}&period2=${end}&interval=1d`;
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  const r = spawnSync("curl", ["-sL", "-A", ua, "--max-time", "20", url], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) throw new Error(`curl exit ${r.status}`);
  return JSON.parse(r.stdout);
}
console.log("\n─── Stocks catch-up (Yahoo via curl) ───");
for (const [assetId, ticker] of Object.entries(STOCK_MAP)) {
  try {
    const j = fetchYahooViaCurl(ticker);
    const result = j?.chart?.result?.[0];
    if (!result) throw new Error("no chart data");
    const ts = result.timestamp ?? [];
    const q = result.indicators?.quote?.[0];
    if (!q) throw new Error("no quote array");
    const rows = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
      if (o == null || c == null) continue;
      rows.push({
        date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        open: o, high: h ?? o, low: l ?? o, close: c, volume: v ?? 0,
      });
    }
    if (rows.length > 0) {
      await db.batch(
        rows.map((r) => ({
          sql: UPSERT,
          args: [assetId, r.date, r.open, r.high, r.low, r.close, r.volume],
        })),
        "write",
      );
      console.log(`  ${assetId.padEnd(12)} +${rows.length} days from Yahoo (${ticker})`);
    }
    await new Promise((r) => setTimeout(r, 1500)); // 1.5s pacing
  } catch (err) {
    console.log(`  ${assetId.padEnd(12)} FAILED: ${err.message}`);
  }
}

// ─── Reprice every June flat outcome ───────────────────────────────
console.log("\n─── Repricing June flat outcomes ───");
const JUNE = 1780272000000;
const stale = await db.execute({
  sql: `SELECT signal_id, asset_id, direction, target_pct, stop_pct,
               price_at_generation, generated_at, expires_at,
               price_at_outcome, realized_pct
        FROM signal_outcomes
        WHERE outcome = 'flat' AND generated_at >= ?
        ORDER BY generated_at ASC`,
  args: [JUNE],
});
console.log(`  Considering ${stale.rows.length} June flat outcomes`);

function dateStr(ms) { return new Date(ms).toISOString().slice(0, 10); }

async function klinesFor(assetId, fromMs, toMs) {
  const r = await db.execute({
    sql: `SELECT date, open, high, low, close FROM klines_daily
          WHERE asset_id = ? AND date >= ? AND date <= ?
          ORDER BY date ASC`,
    args: [assetId, dateStr(fromMs), dateStr(toMs)],
  });
  return r.rows.map((row) => ({
    date: row.date,
    open: Number(row.open), high: Number(row.high),
    low: Number(row.low), close: Number(row.close),
    ts_ms: Date.parse(`${row.date}T00:00:00.000Z`),
  }));
}

function resolveFlat(sig, ks) {
  if (!sig.price_at_generation || sig.price_at_generation <= 0) return null;
  const tgt = sig.direction === "long"
    ? sig.price_at_generation * (1 + sig.target_pct / 100)
    : sig.price_at_generation * (1 - sig.target_pct / 100);
  const stp = sig.direction === "long"
    ? sig.price_at_generation * (1 - sig.stop_pct / 100)
    : sig.price_at_generation * (1 + sig.stop_pct / 100);
  const inW = ks.filter((k) => k.ts_ms >= sig.generated_at && k.ts_ms <= sig.expires_at);
  if (inW.length === 0) return null;
  for (const bar of inW) {
    const tgtHit = sig.direction === "long" ? bar.high >= tgt : bar.low <= tgt;
    const stpHit = sig.direction === "long" ? bar.low <= stp : bar.high >= stp;
    if (tgtHit && stpHit) return { outcome: "stop_hit", outcome_at_ms: bar.ts_ms, price_at_outcome: stp, realized_pct: -sig.stop_pct };
    if (tgtHit) return { outcome: "target_hit", outcome_at_ms: bar.ts_ms, price_at_outcome: tgt, realized_pct: sig.target_pct };
    if (stpHit) return { outcome: "stop_hit", outcome_at_ms: bar.ts_ms, price_at_outcome: stp, realized_pct: -sig.stop_pct };
  }
  const last = inW[inW.length - 1];
  const raw = ((last.close - sig.price_at_generation) / sig.price_at_generation) * 100;
  const dir = sig.direction === "long" ? raw : -raw;
  return { outcome: "flat", outcome_at_ms: sig.expires_at, price_at_outcome: last.close, realized_pct: Number(dir.toFixed(2)) };
}

let repriced = 0, upgraded = 0, stillStuck = 0;
for (const row of stale.rows) {
  if (row.price_at_generation == null) { stillStuck++; continue; }
  const ks = await klinesFor(String(row.asset_id), Number(row.generated_at), Number(row.expires_at));
  if (ks.length === 0) { stillStuck++; continue; }
  const verdict = resolveFlat(
    {
      direction: String(row.direction),
      price_at_generation: Number(row.price_at_generation),
      target_pct: Number(row.target_pct),
      stop_pct: Number(row.stop_pct),
      generated_at: Number(row.generated_at),
      expires_at: Number(row.expires_at),
    },
    ks,
  );
  if (!verdict) { stillStuck++; continue; }
  const oldRp = row.realized_pct == null ? null : Number(row.realized_pct);
  if (verdict.outcome === "flat" && verdict.realized_pct === oldRp) continue;

  const sz = await db.execute({sql: `SELECT suggested_size_usd FROM signals WHERE id = ?`, args: [String(row.signal_id)]});
  const sizeUsd = sz.rows[0]?.suggested_size_usd != null ? Number(sz.rows[0].suggested_size_usd) : null;
  const pnl = verdict.realized_pct != null && sizeUsd != null
    ? (verdict.realized_pct / 100) * sizeUsd : null;

  await db.execute({
    sql: `UPDATE signal_outcomes SET outcome=?, outcome_at=?, price_at_outcome=?, realized_pct=?, realized_pnl_usd=? WHERE signal_id=? AND outcome='flat'`,
    args: [verdict.outcome, verdict.outcome_at_ms, verdict.price_at_outcome, verdict.realized_pct, pnl, String(row.signal_id)],
  });
  repriced++;
  if (verdict.outcome !== "flat") upgraded++;
}
console.log(`  repriced ${repriced}  · ${upgraded} flat → target/stop  · still stuck ${stillStuck}`);

console.log("\nDONE");
process.exit(0);
