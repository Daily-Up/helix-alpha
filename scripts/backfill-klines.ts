/**
 * Kline backfill — fetch real historical daily OHLC from Binance for
 * BTC + a curated satellite universe, and upsert into klines_daily.
 *
 * Why Binance: public REST endpoint, no API key needed, 1000-bar limit
 * which covers ~2.7 years of daily data. Captures real bear/bull
 * regimes (e.g., 2024 mid-cycle correction, 2025 cycle peaks) that
 * v2's acceptance gate needs to evaluate against.
 *
 * Asset-id → Binance-symbol mapping is conservative: only the assets
 * we know are tradable on Binance USDT pairs. Stocks and equity
 * indices aren't covered here (Binance doesn't list them); they
 * remain on whatever coverage the existing system has.
 */

process.env.SOSOVALUE_API_KEY ??= "test";
process.env.ANTHROPIC_API_KEY ??= "test";
process.env.DATABASE_PATH ??= "data/sosoalpha.db";

import Database from "better-sqlite3";
import { resolve } from "node:path";

const dbPath = resolve(process.cwd(), process.env.DATABASE_PATH!);
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// asset_id → Binance USDT pair
const PAIR_MAP: Record<string, string> = {
  "tok-btc": "BTCUSDT",
  "tok-eth": "ETHUSDT",
  "tok-sol": "SOLUSDT",
  "tok-bnb": "BNBUSDT",
  "tok-xrp": "XRPUSDT",
  "tok-link": "LINKUSDT",
  "tok-doge": "DOGEUSDT",
  "tok-avax": "AVAXUSDT",
  "tok-ada": "ADAXUSDT", // ADA on USDT
  "tok-ltc": "LTCUSDT",
  "tok-bch": "BCHUSDT",
  "tok-trx": "TRXUSDT",
  "tok-near": "NEARUSDT",
  "tok-atom": "ATOMUSDT",
  "tok-aave": "AAVEUSDT",
  "tok-uni": "UNIUSDT",
  "tok-mkr": "MKRUSDT",
  "tok-arb": "ARBUSDT",
  "tok-op": "OPUSDT",
  "tok-fil": "FILUSDT",
  "tok-shib": "SHIBUSDT",
  "tok-pepe": "PEPEUSDT",
  "tok-tia": "TIAUSDT",
  "tok-sui": "SUIUSDT",
  "rwa-paxg": "PAXGUSDT", // gold proxy
  "rwa-xaut": "PAXGUSDT", // gold (XAUT same underlying)
};

// ADA's actual ticker is ADAUSDT (not ADAXUSDT — typo correction)
PAIR_MAP["tok-ada"] = "ADAUSDT";

interface BinanceKline {
  open_time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  close_time: number;
}

async function fetchKlines(symbol: string, limit = 1000): Promise<BinanceKline[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status} for ${symbol}: ${text.slice(0, 120)}`);
  }
  const arr = (await resp.json()) as unknown[][];
  return arr.map((row) => ({
    open_time: row[0] as number,
    open: row[1] as string,
    high: row[2] as string,
    low: row[3] as string,
    close: row[4] as string,
    volume: row[5] as string,
    close_time: row[6] as number,
  }));
}

const insertKline = db.prepare(
  `INSERT INTO klines_daily (asset_id, date, open, high, low, close, volume)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(asset_id, date) DO UPDATE SET
     open=excluded.open, high=excluded.high, low=excluded.low,
     close=excluded.close, volume=excluded.volume`,
);

const assetExists = db.prepare(`SELECT 1 FROM assets WHERE id = ?`);

async function backfillOne(assetId: string, symbol: string): Promise<{ rows: number; min: string; max: string }> {
  const klines = await fetchKlines(symbol);
  let min = "";
  let max = "";
  let rows = 0;
  const insertMany = db.transaction((ks: BinanceKline[]) => {
    for (const k of ks) {
      const date = new Date(k.open_time).toISOString().slice(0, 10);
      const open = Number(k.open);
      const high = Number(k.high);
      const low = Number(k.low);
      const close = Number(k.close);
      const volume = Number(k.volume);
      if (![open, high, low, close].every(Number.isFinite)) continue;
      insertKline.run(assetId, date, open, high, low, close, volume);
      if (!min || date < min) min = date;
      if (!max || date > max) max = date;
      rows++;
    }
  });
  insertMany(klines);
  return { rows, min, max };
}

async function main() {
  const start = Date.now();
  let totalRows = 0;
  let skipped = 0;
  for (const [assetId, symbol] of Object.entries(PAIR_MAP)) {
    // Only backfill assets that exist in the universe.
    if (!assetExists.get(assetId)) {
      skipped++;
      continue;
    }
    try {
      const r = await backfillOne(assetId, symbol);
      totalRows += r.rows;
      console.log(`  ✓ ${assetId.padEnd(12)} ${symbol.padEnd(10)} ${r.rows} rows  ${r.min} → ${r.max}`);
    } catch (err) {
      console.log(`  ✗ ${assetId.padEnd(12)} ${symbol}: ${(err as Error).message}`);
    }
    // Mild rate-limit: 100ms between requests (Binance allows ~1200/min).
    await new Promise((r) => setTimeout(r, 100));
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n[backfill] ${totalRows} rows inserted/updated across ${Object.keys(PAIR_MAP).length - skipped} assets in ${elapsed}s`);
  if (skipped > 0) console.log(`[backfill] ${skipped} assets skipped (not in universe)`);

  // BTC summary
  const btcSummary = db
    .prepare(
      `SELECT COUNT(*) as n, MIN(date) as min_d, MAX(date) as max_d FROM klines_daily WHERE asset_id = 'tok-btc'`,
    )
    .get() as { n: number; min_d: string; max_d: string };
  console.log(
    `\n[backfill] BTC coverage: ${btcSummary.n} days  ${btcSummary.min_d} → ${btcSummary.max_d}`,
  );

  // Detect a real bear-market window: scan BTC for any 60d window with DD > 20%
  type Row = { date: string; close: number };
  const btcRows = db
    .prepare<[], Row>(
      `SELECT date, close FROM klines_daily WHERE asset_id='tok-btc' ORDER BY date ASC`,
    )
    .all();
  let bearFound: { start: string; end: string; dd: number } | null = null;
  for (let i = 0; i + 60 < btcRows.length; i++) {
    const slice = btcRows.slice(i, i + 60);
    let peak = slice[0].close;
    let trough = slice[0].close;
    let dd = 0;
    for (const r of slice) {
      if (r.close > peak) {
        peak = r.close;
        trough = r.close;
      }
      if (r.close < trough) trough = r.close;
      const ddHere = peak > 0 ? (r.close - peak) / peak : 0;
      if (ddHere < dd) dd = ddHere;
    }
    if (dd < -0.20 && (!bearFound || dd < bearFound.dd)) {
      bearFound = { start: slice[0].date, end: slice[slice.length - 1].date, dd };
    }
  }
  if (bearFound) {
    console.log(
      `[backfill] worst 60d bear window found: ${bearFound.start} → ${bearFound.end} (DD ${(bearFound.dd * 100).toFixed(1)}%)`,
    );
  } else {
    console.log(`[backfill] WARNING: no 60d window with >20% BTC drawdown in fetched range`);
  }
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
