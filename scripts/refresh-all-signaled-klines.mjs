#!/usr/bin/env node
/**
 * Refresh daily klines for EVERY asset we've ever fired a signal on —
 * not a hardcoded shortlist. This is the durable fix for the "FLAT —"
 * wall on the performance page: outcomes can't be priced without a
 * close at/after expiry, and coverage had drifted (majors stale, many
 * alts never in the map at all).
 *
 * Sources, tiered per asset:
 *   token/rwa   → Binance <SYM>USDT, fallback OKX <SYM>-USDT
 *   stock/trs   → Yahoo Finance (via curl; fetch gets fingerprinted)
 *   index       → skipped (SoSoValue proprietary; no public OHLC)
 *
 *   node scripts/refresh-all-signaled-klines.mjs
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

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const DAYS = 70;
const UPSERT = `INSERT INTO klines_daily (asset_id, date, open, high, low, close, volume)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(asset_id, date) DO UPDATE SET
    open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume`;

async function upsert(assetId, rows) {
  if (!rows.length) return 0;
  await db.batch(rows.map((r) => ({ sql: UPSERT, args: [assetId, r.date, r.open, r.high, r.low, r.close, r.volume ?? 0] })), "write");
  return rows.length;
}

// ── crypto sources (curl — Node fetch is sandbox-blocked here) ──────
function curlJson(url) {
  const r = spawnSync("curl", ["-sL", "--max-time", "20", url], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) throw new Error(`curl ${r.status}`);
  return JSON.parse(r.stdout);
}
function binanceDaily(sym) {
  const end = Date.now(), start = end - DAYS * 86400_000;
  const url = `https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=1d&startTime=${start}&endTime=${end}&limit=${DAYS + 2}`;
  const j = curlJson(url);
  if (!Array.isArray(j)) throw new Error(`binance ${j?.code ?? "bad"}`);
  return j.map((c) => ({ date: new Date(c[0]).toISOString().slice(0, 10), open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] }));
}
function okxDaily(sym) {
  const j = curlJson(`https://www.okx.com/api/v5/market/history-candles?instId=${sym}-USDT&bar=1D&limit=100`);
  if (j.code !== "0" || !Array.isArray(j.data) || !j.data.length) throw new Error(`okx code ${j.code}`);
  return j.data.map((c) => ({ date: new Date(+c[0]).toISOString().slice(0, 10), open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] })).reverse();
}
function yahooDaily(ticker) {
  const end = Math.floor(Date.now() / 1000), start = end - DAYS * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${start}&period2=${end}&interval=1d`;
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  const r = spawnSync("curl", ["-sL", "-A", ua, "--max-time", "20", url], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) throw new Error(`curl ${r.status}`);
  const res = JSON.parse(r.stdout)?.chart?.result?.[0];
  if (!res) throw new Error("no chart");
  const ts = res.timestamp ?? [], q = res.indicators?.quote?.[0] ?? {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], c = q.close?.[i];
    if (o == null || c == null) continue;
    out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), open: o, high: q.high?.[i] ?? o, low: q.low?.[i] ?? o, close: c, volume: q.volume?.[i] ?? 0 });
  }
  return out;
}

// Yahoo ticker overrides where our symbol != the exchange ticker.
const YAHOO_OVERRIDE = { XYZ: "XYZ", BLOCK: "XYZ" };

const assets = (await db.execute(`
  SELECT DISTINCT s.asset_id, a.symbol, a.kind
  FROM signals s LEFT JOIN assets a ON a.id = s.asset_id
  WHERE a.symbol IS NOT NULL`)).rows;

console.log(`Refreshing klines for ${assets.length} signaled assets (${DAYS}d lookback)\n`);
const ok = [], failed = [];
for (const a of assets) {
  const id = String(a.asset_id), sym = String(a.symbol).toUpperCase(), kind = String(a.kind);
  try {
    let rows = [];
    if (kind === "token" || kind === "rwa") {
      try { rows = await binanceDaily(sym); }
      catch { rows = await okxDaily(sym); }        // Binance miss (HYPE/WLFI) → OKX
    } else if (kind === "stock" || kind === "treasury") {
      rows = yahooDaily(YAHOO_OVERRIDE[sym] ?? sym);
      await new Promise((r) => setTimeout(r, 1200));
    } else {
      failed.push(`${id} (${sym}) — ${kind}, no public OHLC source`);
      continue;
    }
    const n = await upsert(id, rows);
    const latest = rows.length ? rows[rows.length - 1].date : "—";
    ok.push(`${id.padEnd(12)} ${sym.padEnd(7)} +${String(n).padStart(3)} days  → ${latest}`);
    console.log(`  ok   ${id.padEnd(12)} ${sym.padEnd(7)} ${n} days → ${latest}`);
  } catch (e) {
    failed.push(`${id} (${sym}) — ${e.message}`);
    console.log(`  FAIL ${id.padEnd(12)} ${sym.padEnd(7)} ${e.message}`);
  }
}

console.log(`\n─── ${ok.length} refreshed, ${failed.length} could not be sourced ───`);
for (const f of failed) console.log(`  ✗ ${f}`);
process.exit(0);
