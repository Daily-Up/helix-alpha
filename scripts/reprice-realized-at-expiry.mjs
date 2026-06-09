#!/usr/bin/env node
/**
 * One-off: re-price `realized_pct` for every resolved June-2026 outcome
 * so it reflects the ACTUAL close-to-close ROI at the signal's expiry —
 * not the fixed target_pct / -stop_pct we set up front.
 *
 * Mirrors the new resolveOutcome() semantics in
 * src/lib/outcomes/resolve.ts:
 *   - outcome LABEL (target_hit/stop_hit/flat) = whether price touched
 *     the level during the holding window (pessimistic on same-day both)
 *   - realized_pct / price_at_outcome = directional close-to-close ROI
 *     from price_at_generation to the expiry-day close (or last bar)
 *
 *   node scripts/reprice-realized-at-expiry.mjs
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

const JUNE = 1780272000000; // 2026-06-01 00:00 UTC (matches perf-page cutoff)

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

/** Re-implements src/lib/outcomes/resolve.ts resolveOutcome (expiry-time). */
function resolveAtExpiry(sig, klines) {
  const { direction, price_at_generation, target_pct, stop_pct,
          generated_at, expires_at } = sig;

  if (price_at_generation == null || price_at_generation <= 0) {
    return { outcome: "flat", outcome_at_ms: expires_at, price_at_outcome: null, realized_pct: 0 };
  }

  const targetPrice = direction === "long"
    ? price_at_generation * (1 + target_pct / 100)
    : price_at_generation * (1 - target_pct / 100);
  const stopPrice = direction === "long"
    ? price_at_generation * (1 - stop_pct / 100)
    : price_at_generation * (1 + stop_pct / 100);

  const inWindow = klines
    .filter((k) => k.ts_ms >= generated_at && k.ts_ms <= expires_at)
    .sort((a, b) => a.ts_ms - b.ts_ms);

  // 1. Label: did price touch target/stop? (stop wins same-day collision)
  let outcome = "flat";
  let labelTs = null;
  for (const bar of inWindow) {
    const targetHit = direction === "long" ? bar.high >= targetPrice : bar.low <= targetPrice;
    const stopHit = direction === "long" ? bar.low <= stopPrice : bar.high >= stopPrice;
    if (stopHit) { outcome = "stop_hit"; labelTs = bar.ts_ms; break; }
    if (targetHit) { outcome = "target_hit"; labelTs = bar.ts_ms; break; }
  }

  // 2. Realized: ALWAYS close-to-close ROI at expiry
  const lastBar = inWindow.length > 0 ? inWindow[inWindow.length - 1] : klines[klines.length - 1];
  if (!lastBar) {
    return { outcome, outcome_at_ms: expires_at, price_at_outcome: null, realized_pct: 0 };
  }
  const finalPx = lastBar.close;
  const rawMove = ((finalPx - price_at_generation) / price_at_generation) * 100;
  const directional = direction === "long" ? rawMove : -rawMove;
  // Bracket bound: realized PnL can't surpass +target_pct / -stop_pct.
  const bounded = Math.min(Math.max(directional, -stop_pct), target_pct);
  return {
    outcome,
    outcome_at_ms: outcome === "flat" ? expires_at : labelTs,
    price_at_outcome: finalPx,
    realized_pct: Number(bounded.toFixed(2)),
  };
}

const rows = (await db.execute({
  sql: `SELECT signal_id, asset_id, direction, target_pct, stop_pct,
               price_at_generation, generated_at, expires_at,
               outcome, realized_pct, price_at_outcome
        FROM signal_outcomes
        WHERE generated_at >= ?
          AND outcome IN ('target_hit','stop_hit','flat')
        ORDER BY generated_at ASC`,
  args: [JUNE],
})).rows;

console.log(`Considering ${rows.length} resolved June outcomes\n`);

let changed = 0, unchanged = 0, stuck = 0, labelFlips = 0;
for (const row of rows) {
  if (row.price_at_generation == null) { stuck++; continue; }
  const ks = await klinesFor(String(row.asset_id), Number(row.generated_at), Number(row.expires_at));
  if (ks.length === 0) { stuck++; continue; }

  const v = resolveAtExpiry({
    direction: String(row.direction),
    price_at_generation: Number(row.price_at_generation),
    target_pct: Number(row.target_pct),
    stop_pct: Number(row.stop_pct),
    generated_at: Number(row.generated_at),
    expires_at: Number(row.expires_at),
  }, ks);

  const oldRp = row.realized_pct == null ? null : Number(row.realized_pct);
  const oldOutcome = String(row.outcome);
  if (v.outcome === oldOutcome && v.realized_pct === oldRp) { unchanged++; continue; }

  const sz = await db.execute({
    sql: `SELECT suggested_size_usd FROM signals WHERE id = ?`,
    args: [String(row.signal_id)],
  });
  const sizeUsd = sz.rows[0]?.suggested_size_usd != null ? Number(sz.rows[0].suggested_size_usd) : null;
  const pnl = v.realized_pct != null && sizeUsd != null ? (v.realized_pct / 100) * sizeUsd : null;

  await db.execute({
    sql: `UPDATE signal_outcomes
          SET outcome=?, outcome_at=?, price_at_outcome=?, realized_pct=?, realized_pnl_usd=?
          WHERE signal_id=?`,
    args: [v.outcome, v.outcome_at_ms, v.price_at_outcome, v.realized_pct, pnl, String(row.signal_id)],
  });
  changed++;
  if (v.outcome !== oldOutcome) labelFlips++;
  console.log(
    `  ${String(row.signal_id).slice(0, 12).padEnd(12)} ${String(row.direction).padEnd(5)} ` +
    `${oldOutcome}→${v.outcome}  rp ${oldRp ?? "—"}→${v.realized_pct}`,
  );
}

console.log(`\nDONE — changed ${changed} (${labelFlips} label flips) · unchanged ${unchanged} · stuck ${stuck}`);
process.exit(0);
