#!/usr/bin/env node
/**
 * Backtest the regime cap against past signals.
 *
 * Walks every signal from the last N days (default 90), computes the BTC
 * (or ETH/SOL) regime AT THE MOMENT the signal fired, and reports:
 *   - what tier the signal was actually assigned
 *   - what tier the regime cap would have produced
 *   - the realized P&L (from signal_outcomes) for each cohort
 *
 * Output answers: "did the cap downgrade signals that turned out to be
 * losers, or did it sandbag winners?" Per-asset breakdown so we can see
 * if the rule is calibrated.
 *
 * Run:
 *   node scripts/backtest-regime-cap.mjs            # last 90d
 *   node scripts/backtest-regime-cap.mjs --days=180 # last 180d
 *   node scripts/backtest-regime-cap.mjs --csv      # also write csv of every row
 */

import { createClient } from "@libsql/client";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
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

const args = process.argv.slice(2);
const daysArg = args.find((a) => a.startsWith("--days="));
const days = daysArg ? Number(daysArg.split("=")[1]) : 90;
const writeCsv = args.includes("--csv");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const cutoffMs = Date.now() - days * DAY_MS;

// ─── Regime compute (same as backfill) ─────────────────────────────────────
async function getRegime(symbol, ts_ms) {
  const fromMs = ts_ms - 90 * DAY_MS;
  const r = await db.execute({
    sql: `SELECT ts_ms, close, high FROM historical_klines_hourly
          WHERE symbol = ? AND ts_ms >= ? AND ts_ms <= ?
          ORDER BY ts_ms ASC`,
    args: [symbol.toUpperCase(), fromMs, ts_ms],
  });
  const rows = r.rows.map((x) => ({
    ts_ms: Number(x.ts_ms),
    close: Number(x.close),
    high: Number(x.high),
  }));
  if (rows.length < 48) return null;
  const anchor = rows[rows.length - 1];
  if (Math.abs(anchor.ts_ms - ts_ms) > 36 * HOUR_MS) return null;
  const findCloseAt = (t) => {
    let lo = 0, hi = rows.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].ts_ms <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best === -1 ? null : rows[best].close;
  };
  const past30 = findCloseAt(ts_ms - 30 * DAY_MS);
  const r30 = past30 && past30 > 0 ? ((anchor.close - past30) / past30) * 100 : null;
  let ath = 0;
  for (const r of rows) if (r.high > ath) ath = r.high;
  const dd = ath === 0 ? 0 : ((anchor.close - ath) / ath) * 100;
  // RSI(14) daily
  const daily = []; let lb = -1;
  for (const r of rows) {
    const b = Math.floor(r.ts_ms / DAY_MS);
    if (b !== lb) { daily.push(r.close); lb = b; } else daily[daily.length - 1] = r.close;
  }
  let rsi = 50;
  if (daily.length >= 15) {
    let g = 0, l = 0;
    for (let i = 1; i <= 14; i++) { const c = daily[i] - daily[i - 1]; if (c > 0) g += c; else l -= c; }
    g /= 14; l /= 14;
    for (let i = 15; i < daily.length; i++) {
      const c = daily[i] - daily[i - 1];
      g = (g * 13 + (c > 0 ? c : 0)) / 14;
      l = (l * 13 + (c < 0 ? -c : 0)) / 14;
    }
    rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  let trend = "sideways";
  if ((r30 ?? 0) > 5 && dd > -8) trend = "up";
  else if ((r30 ?? 0) < -5 && dd < -8) trend = "down";
  return { trend, drawdown_pct: dd, rsi_14: rsi, return_30d_pct: r30 };
}

function pickSymbol(kind, sym) {
  const SKIP = new Set(["macro", "index", "rwa", "etf_fund", "etf_aggregate"]);
  if (SKIP.has(kind)) return null;
  const s = (sym || "").toUpperCase();
  if (s === "ETH" || s === "SOL") return s;
  return "BTC";
}

function wouldCap(regime, tier, direction) {
  if (tier !== "auto") return false;
  if (!regime) return false;
  if (direction === "long" && regime.trend === "down" && regime.drawdown_pct < -8 && regime.rsi_14 < 40) return true;
  if (direction === "short" && regime.trend === "up" && regime.drawdown_pct > -3 && regime.rsi_14 > 60) return true;
  return false;
}

// ─── Load signals + outcomes ───────────────────────────────────────────────
console.log(`Backtest window: last ${days}d  (since ${new Date(cutoffMs).toISOString().slice(0, 10)})\n`);

const sigs = await db.execute({
  sql: `SELECT s.id, s.fired_at, s.asset_id, s.direction, s.tier, s.confidence,
               s.status, a.symbol, a.kind,
               o.outcome, o.realized_pct
        FROM signals s
        JOIN assets a ON a.id = s.asset_id
        LEFT JOIN signal_outcomes o ON o.signal_id = s.id
        WHERE s.fired_at >= ?
        ORDER BY s.fired_at ASC`,
  args: [cutoffMs],
});

console.log(`Loaded ${sigs.rows.length} signals to evaluate`);
if (sigs.rows.length === 0) {
  console.log("Nothing to backtest. Done.");
  process.exit(0);
}

const out = [];
let scanned = 0;
for (const row of sigs.rows) {
  scanned += 1;
  if (scanned % 50 === 0) process.stdout.write(`  ${scanned}/${sigs.rows.length}\r`);
  const sym = pickSymbol(String(row.kind), String(row.symbol));
  if (!sym) {
    out.push({
      ...row,
      regime_symbol: null,
      trend: null,
      drawdown_pct: null,
      rsi_14: null,
      would_cap: false,
    });
    continue;
  }
  const reg = await getRegime(sym, Number(row.fired_at));
  out.push({
    ...row,
    regime_symbol: sym,
    trend: reg?.trend ?? null,
    drawdown_pct: reg?.drawdown_pct ?? null,
    rsi_14: reg?.rsi_14 ?? null,
    return_30d_pct: reg?.return_30d_pct ?? null,
    would_cap: wouldCap(reg, String(row.tier), String(row.direction)),
  });
}
console.log("\n");

// ─── Summarize ─────────────────────────────────────────────────────────────
const auto = out.filter((r) => r.tier === "auto");
const wouldCap_auto = auto.filter((r) => r.would_cap);
// Counter-trend = the regime condition that WOULD trigger the cap
// regardless of tier (i.e. how many signals fired into a hostile tape).
const counterTrend = out.filter((r) => {
  if (!r.trend) return false;
  if (r.direction === "long" && r.trend === "down" && Number(r.drawdown_pct) < -8 && Number(r.rsi_14) < 40) return true;
  if (r.direction === "short" && r.trend === "up" && Number(r.drawdown_pct) > -3 && Number(r.rsi_14) > 60) return true;
  return false;
});
console.log("OVERVIEW:");
console.log(`  total signals                 ${out.length}`);
console.log(`  AUTO tier (before cap)        ${auto.length}`);
console.log(`  would_cap (AUTO→REVIEW)       ${wouldCap_auto.length}  (${auto.length === 0 ? 0 : ((wouldCap_auto.length / auto.length) * 100).toFixed(1)}% of AUTOs)`);
console.log(`  counter-trend (all tiers)     ${counterTrend.length}  (${out.length === 0 ? 0 : ((counterTrend.length / out.length) * 100).toFixed(1)}% of all signals)`);
console.log("    — i.e. how many signals fired into a hostile tape, regardless of whether AUTO");

console.log("\nRegime breakdown for ALL signals fired (regardless of tier):");
const regimeCounts = { up: 0, down: 0, sideways: 0, none: 0 };
for (const r of out) regimeCounts[r.trend ?? "none"] += 1;
console.log(`  up        ${regimeCounts.up}`);
console.log(`  down      ${regimeCounts.down}`);
console.log(`  sideways  ${regimeCounts.sideways}`);
console.log(`  (no data) ${regimeCounts.none}`);

// LONG signals fired in down regime — risky cohort
const longInDown = out.filter((r) => r.direction === "long" && r.trend === "down");
const shortInUp = out.filter((r) => r.direction === "short" && r.trend === "up");
console.log("\nRisky cohorts (regardless of tier):");
console.log(`  LONG fired during DOWN regime    ${longInDown.length}`);
console.log(`  SHORT fired during UP regime     ${shortInUp.length}`);

// Outcome cohorts
function cohortStats(rows, label) {
  const resolved = rows.filter((r) => r.outcome === "target_hit" || r.outcome === "stop_hit" || r.outcome === "flat");
  if (resolved.length === 0) {
    console.log(`  ${label.padEnd(36)}  n=${rows.length}  (no resolved outcomes yet)`);
    return;
  }
  const wins = resolved.filter((r) => r.outcome === "target_hit").length;
  const losses = resolved.filter((r) => r.outcome === "stop_hit").length;
  const flats = resolved.filter((r) => r.outcome === "flat").length;
  const pnl = resolved.reduce((acc, r) => acc + (Number(r.realized_pct) || 0), 0);
  const avg = pnl / resolved.length;
  console.log(`  ${label.padEnd(36)}  n=${rows.length} resolved=${resolved.length}  W=${wins} L=${losses} F=${flats}  avg ${avg.toFixed(2)}%`);
}

console.log("\nP&L by cohort:");
cohortStats(auto, "all AUTO signals (actual)");
cohortStats(wouldCap_auto, "AUTO that would be CAPPED");
cohortStats(auto.filter((r) => !r.would_cap), "AUTO that would PASS uncapped");

// Per-asset breakdown
console.log("\nWould-cap signals by primary asset:");
const byAsset = new Map();
for (const r of wouldCap_auto) {
  const k = String(r.symbol);
  byAsset.set(k, (byAsset.get(k) ?? 0) + 1);
}
for (const [k, v] of [...byAsset.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(8)}  ${v}`);
}

// Per-direction
console.log("\nWould-cap signals by direction:");
const long = wouldCap_auto.filter((r) => r.direction === "long").length;
const short = wouldCap_auto.filter((r) => r.direction === "short").length;
console.log(`  long   ${long}`);
console.log(`  short  ${short}`);

if (writeCsv) {
  const headers = ["signal_id", "fired_at", "symbol", "direction", "tier", "regime_symbol", "trend", "drawdown_pct", "rsi_14", "return_30d_pct", "would_cap", "outcome", "realized_pct"];
  const lines = [headers.join(",")];
  for (const r of out) {
    lines.push([
      r.id, new Date(Number(r.fired_at)).toISOString(),
      r.symbol, r.direction, r.tier, r.regime_symbol ?? "", r.trend ?? "",
      r.drawdown_pct ?? "", r.rsi_14 ?? "", r.return_30d_pct ?? "",
      r.would_cap ? 1 : 0, r.outcome ?? "", r.realized_pct ?? "",
    ].join(","));
  }
  const path = `tmp_regime_backtest_${days}d.csv`;
  writeFileSync(path, lines.join("\n"));
  console.log(`\nDetail CSV: ${path}`);
}

process.exit(0);
