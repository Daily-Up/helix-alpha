#!/usr/bin/env node
/**
 * Clean signal_outcomes:
 *
 *   1. Drop shadow-v2 backtest rows (framework_version='v2' or signal_id
 *      ending '-shadow-v2'). They were leaking onto the public
 *      /signals/performance page; they belong in internal A/B compare
 *      tooling, not the user-facing receipts.
 *
 *   2. Drop noise-subtype rows:
 *        - `regulatory_statement` (Fed governor speeches, SEC press
 *          comments — no concrete action)
 *        - `earnings_reaction` (mis-categorisation on treasury assets
 *          like trs-mstr; the underlying news is usually a quarterly
 *          BTC-yield-per-share update, not an earnings beat/miss)
 *
 *   3. Within each (asset_id, generated_at-day, catalyst_subtype,
 *      direction) bucket, keep the row with the lowest signal_id
 *      and delete the rest. The signal-gen path was firing 74 times
 *      on a single perp-us500 macro_print event — that's a separate
 *      bug to fix in src/lib/trading, but for now we just want the
 *      table not to lie.
 *
 * Companion change: the performance page also adds these filters
 * defensively at the SQL layer so future bad rows can't pollute the
 * view even if we forget to re-run this script.
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

console.log("Before:");
const before = await db.execute(
  "SELECT outcome, COUNT(*) n FROM signal_outcomes GROUP BY outcome",
);
for (const r of before.rows) console.log(" ", r);

// ─── 1. shadow-v2 rows ──────────────────────────────────────────────────
const r1 = await db.execute(
  `DELETE FROM signal_outcomes
   WHERE framework_version = 'v2'
      OR signal_id LIKE '%-shadow-v2'`,
);
console.log(`\n[1] Deleted ${r1.rowsAffected} shadow-v2 rows`);

// ─── 2. noise subtypes ──────────────────────────────────────────────────
const r2 = await db.execute(
  `DELETE FROM signal_outcomes
   WHERE catalyst_subtype IN ('regulatory_statement', 'earnings_reaction')`,
);
console.log(`[2] Deleted ${r2.rowsAffected} regulatory_statement / earnings_reaction rows`);

// ─── 3. dedupe within (asset, day, subtype, direction) ─────────────────
//
// SQLite/Turso: identify canonical row per group, delete the rest.
const r3 = await db.execute(
  `DELETE FROM signal_outcomes
   WHERE signal_id IN (
     SELECT o1.signal_id
     FROM signal_outcomes o1
     WHERE o1.signal_id <> (
       SELECT MIN(o2.signal_id)
       FROM signal_outcomes o2
       WHERE o2.asset_id = o1.asset_id
         AND o2.catalyst_subtype = o1.catalyst_subtype
         AND o2.direction = o1.direction
         AND substr(datetime(o2.generated_at/1000,'unixepoch'),1,10)
             = substr(datetime(o1.generated_at/1000,'unixepoch'),1,10)
     )
   )`,
);
console.log(`[3] Deleted ${r3.rowsAffected} duplicate rows (same asset+day+subtype+direction)`);

console.log("\nAfter:");
const after = await db.execute(
  "SELECT outcome, COUNT(*) n FROM signal_outcomes GROUP BY outcome",
);
for (const r of after.rows) console.log(" ", r);

const expired = await db.execute(
  `SELECT outcome, COUNT(*) n, ROUND(AVG(realized_pct),2) avg
   FROM signal_outcomes
   WHERE expires_at < strftime('%s','now')*1000
   GROUP BY outcome`,
);
console.log("\nExpired only:");
for (const r of expired.rows) console.log(" ", r);

process.exit(0);
