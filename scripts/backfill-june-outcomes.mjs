#!/usr/bin/env node
/**
 * One-off: insert signal_outcomes rows for every June-2026 signal
 * that's missing one.
 *
 * Some signals slipped through the wiring (transient DB hiccups or
 * pre-fix bugs) and never had insertOutcomeFromSignal run after
 * insertSignal. The resolver only walks rows in signal_outcomes, so
 * those signals never get a verdict and never show up on the
 * performance page.
 *
 * Run via `node scripts/backfill-june-outcomes.mjs`.
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

const JUNE = Date.UTC(2026, 5, 1);
const HORIZON_HOURS = (s) => {
  if (!s) return 24;
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)([hd])$/i);
  if (!m) return 24;
  const n = parseFloat(m[1]);
  return m[2].toLowerCase() === "d" ? Math.round(n * 24) : Math.round(n);
};
const CRYPTO_ADJ = new Set([
  "COIN","MSTR","MARA","RIOT","HOOD","CIFR","IREN","CLSK",
  "HUT","BLOCK","GLXY","WULF","CRCL","XYZ"
]);
const LARGE = new Set(["BTC","ETH"]);
const MID = new Set(["SOL","XRP","BNB","ADA","DOT","AVAX","DOGE","TRX","LINK","LTC","ARB","OP"]);
function classifyForBackfill(kind, symbol) {
  const s = (symbol || "").toUpperCase();
  if (kind === "token" || kind === "rwa") {
    if (LARGE.has(s)) return "large_cap_crypto";
    if (MID.has(s)) return "mid_cap_crypto";
    return "small_cap_crypto";
  }
  if (kind === "stock" || kind === "treasury") {
    return CRYPTO_ADJ.has(s) ? "crypto_adjacent_equity" : "broad_equity";
  }
  if (kind === "etf" || kind === "etf_fund" || kind === "etf_aggregate") return "large_cap_crypto";
  return "small_cap_crypto";
}

async function priceAtOrBefore(assetId, ts) {
  const date = new Date(ts).toISOString().slice(0, 10);
  const r = await db.execute({
    sql: `SELECT close FROM klines_daily WHERE asset_id = ? AND date <= ? ORDER BY date DESC LIMIT 1`,
    args: [assetId, date],
  });
  return r.rows[0]?.close != null && Number(r.rows[0].close) > 0 ? Number(r.rows[0].close) : null;
}

const stragglers = await db.execute({
  sql: `SELECT s.id, s.asset_id, s.fired_at, s.expected_horizon, s.expires_at,
               s.direction, s.tier, s.confidence,
               s.catalyst_subtype, s.suggested_target_pct, s.suggested_stop_pct
        FROM signals s
        LEFT JOIN signal_outcomes o ON o.signal_id = s.id
        WHERE s.fired_at >= ?
          AND o.signal_id IS NULL`,
  args: [JUNE],
});

console.log(`Found ${stragglers.rows.length} June signals missing outcome rows`);

let inserted = 0, skipped = 0;
for (const sig of stragglers.rows) {
  const asset = await db.execute({
    sql: `SELECT kind, symbol FROM assets WHERE id = ?`,
    args: [String(sig.asset_id)],
  });
  if (asset.rows.length === 0) { skipped++; continue; }
  const a = asset.rows[0];
  const assetClass = classifyForBackfill(String(a.kind), String(a.symbol));
  const price = await priceAtOrBefore(String(sig.asset_id), Number(sig.fired_at));
  const horizonHours = HORIZON_HOURS(sig.expected_horizon);
  const expiresAt = sig.expires_at ?? (Number(sig.fired_at) + horizonHours * 3600 * 1000);

  await db.execute({
    sql: `INSERT INTO signal_outcomes (
            signal_id, asset_id, direction, catalyst_subtype, asset_class,
            tier, conviction, generated_at, horizon_hours, expires_at,
            price_at_generation, target_pct, stop_pct,
            recorded_at, framework_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'v1')`,
    args: [
      String(sig.id), String(sig.asset_id), String(sig.direction),
      sig.catalyst_subtype ?? "other", assetClass,
      String(sig.tier), Number(sig.confidence),
      Number(sig.fired_at), horizonHours, Number(expiresAt),
      price, Number(sig.suggested_target_pct ?? 0), Number(sig.suggested_stop_pct ?? 0),
      Date.now(),
    ],
  });
  inserted++;
  console.log(`  + ${sig.id} ${a.symbol} ${sig.direction} (price=${price ?? "—"})`);
}

console.log(`\nDONE — inserted ${inserted}, skipped ${skipped}`);
process.exit(0);
