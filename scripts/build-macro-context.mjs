#!/usr/bin/env node
/**
 * Build the macro_calibration dataset.
 *
 * For each scheduled macro release (CPI, Core CPI, PCE, Core PCE, NFP,
 * Unemployment, GDP, Retail Sales, ISM, Consumer Sentiment, FOMC) AND
 * each hand-curated special event (SVB, yen carry unwind, debt-ceiling,
 * etc.) we pull:
 *
 *   - actual + previous value (from FRED public CSV — no API key)
 *   - SPX / DXY / 10Y same-day move (from FRED daily series)
 *   - BTC 1h reaction (from our historical_klines_hourly table — we
 *     already have hourly data ingested)
 *   - BTC 1d/3d/7d + ETH 1d (daily Binance public API)
 *
 * Writes directly into Turso `macro_calibration`. Idempotent on id.
 *
 * Run:
 *   node scripts/build-macro-context.mjs
 *
 * Source notes:
 *   - FRED graph CSV endpoint requires no auth. Each series is one HTTP
 *     call returning the full history; we cache in memory and look up
 *     each release date's value.
 *   - Standard release times (UTC) are hardcoded per event_type. CPI/NFP
 *     hit at 12:30 UTC (8:30 ET). FOMC at 18:00 UTC. PCE at 12:30 UTC.
 *     ECB at 12:15 UTC. BoJ at 03:00 UTC. Good enough for 1h-window math.
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
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

// ─── Ensure schema (idempotent) ─────────────────────────────────────────────
const alters = [
  `CREATE TABLE IF NOT EXISTS macro_calibration (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    ts_ms INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    description TEXT NOT NULL,
    actual REAL,
    previous REAL,
    surprise_proxy REAL,
    spx_move_1d_pct REAL,
    dxy_move_1d_pct REAL,
    ten_year_move_bp REAL,
    btc_move_1h_pct REAL,
    btc_move_1d_pct REAL,
    btc_move_3d_pct REAL,
    btc_move_7d_pct REAL,
    eth_move_1d_pct REAL,
    notes TEXT,
    ingested_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_macro_calib_type ON macro_calibration(event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_macro_calib_date ON macro_calibration(date)`,
  `CREATE INDEX IF NOT EXISTS idx_macro_calib_ts ON macro_calibration(ts_ms DESC)`,
];
for (const sql of alters) await db.execute(sql);

// ─── FRED loader ────────────────────────────────────────────────────────────
const FRED = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=";
const fredCache = new Map();

async function loadFred(seriesId) {
  if (fredCache.has(seriesId)) return fredCache.get(seriesId);
  const url = `${FRED}${seriesId}&cosd=2019-01-01`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId} ${res.status}`);
  const text = await res.text();
  const rows = text.trim().split("\n").slice(1); // drop header
  const map = []; // sorted array of {date, value}
  for (const line of rows) {
    const [d, v] = line.split(",");
    if (!d || v === undefined || v === "" || v === ".") continue;
    const val = Number(v);
    if (!Number.isFinite(val)) continue;
    map.push({ date: d, value: val });
  }
  fredCache.set(seriesId, map);
  return map;
}

// Find the value at or before `date` (YYYY-MM-DD).
function findAtOrBefore(series, date) {
  let lo = 0, hi = series.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= date) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best === -1 ? null : series[best];
}

// Find the value strictly AFTER `date`.
function findAfter(series, date) {
  for (const r of series) if (r.date > date) return r;
  return null;
}

// ─── Release-time map (UTC HH:MM) ───────────────────────────────────────────
// We hardcode standard release times so we can hit the 1h candle correctly.
const RELEASE_TIME_UTC = {
  CPI: { h: 12, m: 30 },
  Core_CPI: { h: 12, m: 30 },
  PCE: { h: 12, m: 30 },
  Core_PCE: { h: 12, m: 30 },
  NFP: { h: 12, m: 30 },
  Unemployment: { h: 12, m: 30 },
  GDP: { h: 12, m: 30 },
  Retail_Sales: { h: 12, m: 30 },
  ISM_Manufacturing: { h: 14, m: 0 },
  ISM_Services: { h: 14, m: 0 },
  JOLTS: { h: 14, m: 0 },
  Consumer_Sentiment: { h: 14, m: 0 },
  FOMC_decision: { h: 18, m: 0 },
  ECB: { h: 12, m: 15 },
  BoJ: { h: 3, m: 0 },
  special: { h: 14, m: 0 },
};

function tsForRelease(eventType, dateStr) {
  const t = RELEASE_TIME_UTC[eventType] ?? RELEASE_TIME_UTC.special;
  return Date.parse(`${dateStr}T${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}:00Z`);
}

// ─── Cross-asset move from FRED daily series ────────────────────────────────
async function crossMove(series, dateStr) {
  const data = await loadFred(series);
  const here = findAtOrBefore(data, dateStr);
  if (!here) return null;
  // Find the previous trading day's value
  const idx = data.findIndex((r) => r.date === here.date);
  if (idx <= 0) return null;
  const prev = data[idx - 1];
  if (prev.value === 0) return null;
  return ((here.value - prev.value) / prev.value) * 100;
}

async function tenYearMoveBps(dateStr) {
  const data = await loadFred("DGS10");
  const here = findAtOrBefore(data, dateStr);
  if (!here) return null;
  const idx = data.findIndex((r) => r.date === here.date);
  if (idx <= 0) return null;
  return (here.value - data[idx - 1].value) * 100; // % points → bps
}

// ─── BTC reaction lookup ────────────────────────────────────────────────────
async function btcHourlyMove(ts_ms) {
  // Find the candle whose ts_ms is the hour containing release, then the close 1h later.
  const r = await db.execute({
    sql: `SELECT ts_ms, open, close FROM historical_klines_hourly
          WHERE symbol = 'BTC' AND ts_ms <= ? AND ts_ms >= ?
          ORDER BY ts_ms DESC LIMIT 1`,
    args: [ts_ms, ts_ms - 60 * 60 * 1000],
  });
  if (r.rows.length === 0) return null;
  const at = r.rows[0];
  if (Number(at.open) === 0) return null;
  return ((Number(at.close) - Number(at.open)) / Number(at.open)) * 100;
}

// Binance daily candles for BTC/ETH N-day moves.
async function dailyMoves(dateStr) {
  const startMs = Date.parse(`${dateStr}T00:00:00Z`) - 24 * 60 * 60 * 1000;
  const btc = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=${startMs}&limit=10`);
  const eth = await fetch(`https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1d&startTime=${startMs}&limit=10`);
  const btcArr = btc.ok ? await btc.json() : [];
  const ethArr = eth.ok ? await eth.json() : [];
  await new Promise((r) => setTimeout(r, 60));
  if (btcArr.length < 8) return { btc_1d: null, btc_3d: null, btc_7d: null, eth_1d: null };
  // [0]=day-before, [1]=event-day, [2]=day-after, [4]=3d, [8]=7d
  const c = (i, arr) => (arr[i] ? Number(arr[i][4]) : null);
  const pct = (from, to) => from && to && from > 0 ? ((to - from) / from) * 100 : null;
  return {
    btc_1d: pct(c(1, btcArr), c(2, btcArr)),
    btc_3d: pct(c(1, btcArr), c(4, btcArr)),
    btc_7d: pct(c(1, btcArr), c(8, btcArr)),
    eth_1d: pct(c(1, ethArr), c(2, ethArr)),
  };
}

// ─── Build release-date list from existing catalyst dates ──────────────────
// We mirror the dates already in our catalysts table but pull the macro
// actuals fresh from FRED.

// Lists copied from tmp_catalysts.mjs so the script is self-contained.
const FOMC = [
  "2020-01-29","2020-03-03","2020-03-15","2020-04-29","2020-06-10","2020-07-29","2020-09-16","2020-11-05","2020-12-16",
  "2021-01-27","2021-03-17","2021-04-28","2021-06-16","2021-07-28","2021-09-22","2021-11-03","2021-12-15",
  "2022-01-26","2022-03-16","2022-05-04","2022-06-15","2022-07-27","2022-09-21","2022-11-02","2022-12-14",
  "2023-02-01","2023-03-22","2023-05-03","2023-06-14","2023-07-26","2023-09-20","2023-11-01","2023-12-13",
  "2024-01-31","2024-03-20","2024-05-01","2024-06-12","2024-07-31","2024-09-18","2024-11-07","2024-12-18",
  "2025-01-29","2025-03-19","2025-05-07","2025-06-18","2025-07-30","2025-09-17","2025-10-29","2025-12-10",
];
const CPI = [
  "2020-01-14","2020-02-13","2020-03-11","2020-04-10","2020-05-12","2020-06-10","2020-07-14","2020-08-12","2020-09-11","2020-10-13","2020-11-12","2020-12-10",
  "2021-01-13","2021-02-10","2021-03-10","2021-04-13","2021-05-12","2021-06-10","2021-07-13","2021-08-11","2021-09-14","2021-10-13","2021-11-10","2021-12-10",
  "2022-01-12","2022-02-10","2022-03-10","2022-04-12","2022-05-11","2022-06-10","2022-07-13","2022-08-10","2022-09-13","2022-10-13","2022-11-10","2022-12-13",
  "2023-01-12","2023-02-14","2023-03-14","2023-04-12","2023-05-10","2023-06-13","2023-07-12","2023-08-10","2023-09-13","2023-10-12","2023-11-14","2023-12-12",
  "2024-01-11","2024-02-13","2024-03-12","2024-04-10","2024-05-15","2024-06-12","2024-07-11","2024-08-14","2024-09-11","2024-10-10","2024-11-13","2024-12-11",
  "2025-01-15","2025-02-12","2025-03-12","2025-04-10","2025-05-13","2025-06-11","2025-07-15","2025-08-12","2025-09-11","2025-10-15","2025-11-13","2025-12-10",
];
const NFP = [
  "2020-01-10","2020-02-07","2020-03-06","2020-04-03","2020-05-08","2020-06-05","2020-07-02","2020-08-07","2020-09-04","2020-10-02","2020-11-06","2020-12-04",
  "2021-01-08","2021-02-05","2021-03-05","2021-04-02","2021-05-07","2021-06-04","2021-07-02","2021-08-06","2021-09-03","2021-10-08","2021-11-05","2021-12-03",
  "2022-01-07","2022-02-04","2022-03-04","2022-04-01","2022-05-06","2022-06-03","2022-07-08","2022-08-05","2022-09-02","2022-10-07","2022-11-04","2022-12-02",
  "2023-01-06","2023-02-03","2023-03-10","2023-04-07","2023-05-05","2023-06-02","2023-07-07","2023-08-04","2023-09-01","2023-10-06","2023-11-03","2023-12-08",
  "2024-01-05","2024-02-02","2024-03-08","2024-04-05","2024-05-03","2024-06-07","2024-07-05","2024-08-02","2024-09-06","2024-10-04","2024-11-01","2024-12-06",
  "2025-01-10","2025-02-07","2025-03-07","2025-04-04","2025-05-02","2025-06-06","2025-07-03","2025-08-01","2025-09-05","2025-10-03","2025-11-07","2025-12-05",
];
const PCE = [
  "2020-01-31","2020-02-28","2020-03-27","2020-04-30","2020-05-29","2020-06-26","2020-07-31","2020-08-28","2020-09-25","2020-10-30","2020-11-25","2020-12-23",
  "2021-01-29","2021-02-26","2021-03-26","2021-04-30","2021-05-28","2021-06-25","2021-07-30","2021-08-27","2021-09-30","2021-10-29","2021-11-24","2021-12-23",
  "2022-01-28","2022-02-25","2022-03-31","2022-04-29","2022-05-27","2022-06-30","2022-07-29","2022-08-26","2022-09-30","2022-10-28","2022-11-30","2022-12-23",
  "2023-01-27","2023-02-24","2023-03-31","2023-04-28","2023-05-26","2023-06-30","2023-07-28","2023-08-31","2023-09-29","2023-10-27","2023-11-30","2023-12-22",
  "2024-01-26","2024-02-29","2024-03-29","2024-04-26","2024-05-31","2024-06-28","2024-07-26","2024-08-30","2024-09-27","2024-10-31","2024-11-27","2024-12-20",
  "2025-01-31","2025-02-28","2025-03-28","2025-04-30","2025-05-30","2025-06-27","2025-07-31","2025-08-29","2025-09-26","2025-10-31","2025-11-26","2025-12-19",
];

// ─── Special hand-curated macro events (Prompt 3 coverage requirement) ─────
const SPECIAL = [
  ["2020-03-03", "FOMC_decision", "Fed emergency 50bp cut (intermeeting)", null],
  ["2020-03-15", "FOMC_decision", "Fed emergency 100bp cut to 0%, unlimited QE", null],
  ["2022-04-01", "special", "2s10s yield curve inverts for first time of cycle", null],
  ["2022-07-13", "special", "2s10s curve hits -22bps, deepest since 2000", null],
  ["2023-01-19", "special", "US Treasury hits debt ceiling, extraordinary measures begin", null],
  ["2023-03-09", "special", "SVB stock halted, $42B in single-day outflows reported", null],
  ["2023-03-10", "special", "Silicon Valley Bank collapses, taken into FDIC receivership", null],
  ["2023-03-12", "special", "Signature Bank closed by NY regulators, BTFP launched", null],
  ["2023-03-13", "special", "First Republic Bank stock crashes, $30B deposit rescue", null],
  ["2023-03-19", "special", "UBS forced takeover of Credit Suisse for $3.25B", null],
  ["2023-05-01", "special", "First Republic seized + sold to JPMorgan", null],
  ["2023-06-03", "special", "Debt ceiling suspended via Fiscal Responsibility Act", null],
  ["2024-08-05", "special", "Yen carry-trade unwind, BTC -16% intraday, Nikkei -12%", null],
  ["2024-09-04", "special", "2s10s yield curve disinverts briefly after 2-yr inversion", null],
  ["2024-09-18", "FOMC_decision", "First Fed cut of cycle: 50bp jumbo cut", null],
  ["2025-01-21", "special", "US Treasury hits debt ceiling again, extraordinary measures resume", null],
];

// ─── Build candidate list ──────────────────────────────────────────────────
const candidates = [];
for (const d of FOMC) candidates.push({ date: d, event_type: "FOMC_decision", desc: "FOMC rate decision", series: "DFF" });
for (const d of CPI) candidates.push({ date: d, event_type: "CPI", desc: "US CPI release", series: "CPIAUCSL" });
for (const d of NFP) candidates.push({ date: d, event_type: "NFP", desc: "US Nonfarm Payrolls", series: "PAYEMS" });
for (const d of PCE) candidates.push({ date: d, event_type: "PCE", desc: "US PCE inflation release", series: "PCEPI" });
for (const [d, type, desc] of SPECIAL) candidates.push({ date: d, event_type: type, desc, series: null });

candidates.sort((a, b) => a.date.localeCompare(b.date));
console.log(`Building ${candidates.length} macro events…\n`);

// ─── Process each candidate ─────────────────────────────────────────────────
const out = [];
let i = 0;
for (const cand of candidates) {
  i += 1;
  const id = `${cand.event_type.toLowerCase().replace(/_/g, "-")}-${cand.date}`;
  const ts_ms = tsForRelease(cand.event_type, cand.date);

  let actual = null, previous = null, surprise = null;
  if (cand.series) {
    try {
      const data = await loadFred(cand.series);
      // For monthly series the "release" reflects PRIOR month's value.
      // We find the most recent observation that would have been published by the release date.
      const here = findAtOrBefore(data, cand.date);
      if (here) {
        actual = here.value;
        const idxOf = data.findIndex((r) => r.date === here.date);
        if (idxOf > 0) {
          previous = data[idxOf - 1].value;
          surprise = actual - previous;
        }
      }
    } catch (e) {
      console.warn(`  [${i}] ${cand.date} FRED ${cand.series} failed: ${e.message}`);
    }
  }

  const spx = await crossMove("SP500", cand.date).catch(() => null);
  const dxy = await crossMove("DTWEXBGS", cand.date).catch(() => null);
  const ten_year = await tenYearMoveBps(cand.date).catch(() => null);
  const btc_1h = await btcHourlyMove(ts_ms).catch(() => null);
  const daily = await dailyMoves(cand.date).catch(() => ({ btc_1d: null, btc_3d: null, btc_7d: null, eth_1d: null }));

  out.push({
    id,
    date: cand.date,
    ts_ms,
    event_type: cand.event_type,
    description: cand.desc,
    actual, previous, surprise_proxy: surprise,
    spx_move_1d_pct: spx,
    dxy_move_1d_pct: dxy,
    ten_year_move_bp: ten_year,
    btc_move_1h_pct: btc_1h,
    btc_move_1d_pct: daily.btc_1d,
    btc_move_3d_pct: daily.btc_3d,
    btc_move_7d_pct: daily.btc_7d,
    eth_move_1d_pct: daily.eth_1d,
    notes: null,
  });

  if (i % 25 === 0 || i === candidates.length) {
    const last = out[out.length - 1];
    const fmt = (x) => x == null ? "—" : (typeof x === "number" ? x.toFixed(2) : String(x));
    console.log(`  [${String(i).padStart(3)}/${candidates.length}] ${cand.date} ${cand.event_type.padEnd(16)} actual=${fmt(actual)} btc_1h=${fmt(last.btc_move_1h_pct)}% btc_1d=${fmt(last.btc_move_1d_pct)}%`);
  }
}

// ─── Upsert ─────────────────────────────────────────────────────────────────
const upsertSql = `INSERT INTO macro_calibration (
  id, date, ts_ms, event_type, description, actual, previous, surprise_proxy,
  spx_move_1d_pct, dxy_move_1d_pct, ten_year_move_bp,
  btc_move_1h_pct, btc_move_1d_pct, btc_move_3d_pct, btc_move_7d_pct, eth_move_1d_pct, notes
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  actual = excluded.actual,
  previous = excluded.previous,
  surprise_proxy = excluded.surprise_proxy,
  spx_move_1d_pct = excluded.spx_move_1d_pct,
  dxy_move_1d_pct = excluded.dxy_move_1d_pct,
  ten_year_move_bp = excluded.ten_year_move_bp,
  btc_move_1h_pct = excluded.btc_move_1h_pct,
  btc_move_1d_pct = excluded.btc_move_1d_pct,
  btc_move_3d_pct = excluded.btc_move_3d_pct,
  btc_move_7d_pct = excluded.btc_move_7d_pct,
  eth_move_1d_pct = excluded.eth_move_1d_pct
`;

const BATCH = 50;
let upserted = 0;
for (let j = 0; j < out.length; j += BATCH) {
  const slice = out.slice(j, j + BATCH);
  await db.batch(
    slice.map((r) => ({
      sql: upsertSql,
      args: [
        r.id, r.date, r.ts_ms, r.event_type, r.description,
        r.actual, r.previous, r.surprise_proxy,
        r.spx_move_1d_pct, r.dxy_move_1d_pct, r.ten_year_move_bp,
        r.btc_move_1h_pct, r.btc_move_1d_pct, r.btc_move_3d_pct, r.btc_move_7d_pct, r.eth_move_1d_pct,
        r.notes,
      ],
    })),
    "write",
  );
  upserted += slice.length;
}
console.log(`\nDONE — upserted ${upserted} macro events`);

// ─── Verify ─────────────────────────────────────────────────────────────────
const v = await db.execute(
  `SELECT event_type, COUNT(*) AS n,
          ROUND(AVG(btc_move_1h_pct), 2) AS avg_btc1h,
          ROUND(AVG(btc_move_1d_pct), 2) AS avg_btc1d
   FROM macro_calibration
   GROUP BY event_type ORDER BY n DESC`,
);
console.log("\nEvent-type distribution:");
for (const row of v.rows) {
  console.log(`  ${String(row.event_type).padEnd(18)}  n=${String(row.n).padStart(3)}   avg BTC 1h=${row.avg_btc1h}%   avg BTC 1d=${row.avg_btc1d}%`);
}

process.exit(0);
