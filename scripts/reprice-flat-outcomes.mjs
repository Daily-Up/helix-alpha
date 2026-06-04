#!/usr/bin/env node
/**
 * Re-resolve every `flat` signal_outcome whose `price_at_outcome` is
 * NULL. Those rows were locked in when klines_daily lagged the
 * resolution job — they show as "0.00%" on /signals/performance even
 * though the asset actually moved.
 *
 * The fix: pull current klines_daily for [generated_at..expires_at],
 * use the close on / just before expiry, and compute the directional
 * close-to-close ROI from price_at_generation. Persist with
 * `recomputeFlatResolution` (which guards on outcome='flat' so we
 * can't trample target/stop hits).
 *
 * Idempotent — running it again on already-repriced rows is a no-op
 * (they now have price_at_outcome ≠ NULL).
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

function dateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

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

  // Walk forward — first bar that crosses target or stop changes the
  // outcome from flat to target_hit / stop_hit. Otherwise flat at
  // close of last bar in window.
  for (const bar of inWindow) {
    const targetHit = direction === "long" ? bar.high >= targetPrice : bar.low <= targetPrice;
    const stopHit = direction === "long" ? bar.low <= stopPrice : bar.high >= stopPrice;
    if (targetHit && stopHit) {
      return { outcome: "stop_hit", outcome_at_ms: bar.ts_ms, price_at_outcome: stopPrice, realized_pct: -stop_pct };
    }
    if (targetHit) {
      return { outcome: "target_hit", outcome_at_ms: bar.ts_ms, price_at_outcome: targetPrice, realized_pct: target_pct };
    }
    if (stopHit) {
      return { outcome: "stop_hit", outcome_at_ms: bar.ts_ms, price_at_outcome: stopPrice, realized_pct: -stop_pct };
    }
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

// Reprice every EXPIRED flat outcome. Two reasons:
//   1. The "stale klines locked us at 0%" set — rows with NULL
//      price_at_outcome that got fixed by the first pass.
//   2. Rows where klines were partially available at resolve time:
//      the resolver used the close of the last available bar (which
//      was earlier than expires_at), so price_at_outcome is non-null
//      but doesn't reflect the actual close at expiry. Now that
//      klines_daily is current, we replay against the correct window.
//
// Only EXPIRED signals — anything still pending should stay pending.
const r = await db.execute({
  sql: `SELECT signal_id, asset_id, direction, target_pct, stop_pct,
               price_at_generation, generated_at, expires_at,
               price_at_outcome, realized_pct
        FROM signal_outcomes
        WHERE outcome = 'flat'
          AND expires_at < ?
        ORDER BY generated_at ASC`,
  args: [Date.now()],
});

console.log(`Found ${r.rows.length} expired flat outcomes to consider.\n`);

let touched = 0;
let still_no_klines = 0;
let upgraded = 0; // flat → target_hit / stop_hit
let realized_changed = 0; // realized_pct moved meaningfully
let unchanged = 0;

for (const row of r.rows) {
  if (row.price_at_generation == null) {
    // Can't compute a directional move with no anchor.
    continue;
  }
  const klines = await klinesForWindow(
    String(row.asset_id),
    Number(row.generated_at),
    Number(row.expires_at),
  );
  if (klines.length === 0) {
    still_no_klines++;
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

  const oldRealized = row.realized_pct != null ? Number(row.realized_pct) : null;
  const isUpgrade = verdict.outcome !== "flat";
  const realizedShifted =
    verdict.realized_pct != null &&
    (oldRealized == null || Math.abs(verdict.realized_pct - oldRealized) >= 0.01);

  if (!isUpgrade && !realizedShifted) {
    unchanged++;
    continue;
  }

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
  touched++;
  if (isUpgrade) upgraded++;
  else realized_changed++;

  if (touched % 5 === 0 || isUpgrade) {
    const oldStr = oldRealized == null ? "—" : oldRealized.toFixed(2) + "%";
    const newStr = verdict.realized_pct == null ? "—" : verdict.realized_pct.toFixed(2) + "%";
    console.log(`  [${touched}] ${row.asset_id} ${row.direction} ${oldStr} → ${verdict.outcome} ${newStr}`);
  }
}

console.log(`\nDONE`);
console.log(`  Touched:            ${touched}`);
console.log(`    upgraded to hit:  ${upgraded}`);
console.log(`    realized changed: ${realized_changed}`);
console.log(`  Unchanged:          ${unchanged}`);
console.log(`  Missing klines:     ${still_no_klines}`);

process.exit(0);
