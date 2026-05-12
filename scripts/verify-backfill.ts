/**
 * Standalone verification of the shadow-backfill fix. Equivalent to
 * `curl -X POST http://localhost:3000/api/jobs/backfill-shadow` but
 * runs against the local sqlite without booting Next, so we can
 * confirm `outcomes_written > 0` after the expired-signal-filter fix.
 */
process.env.SOSOVALUE_API_KEY ??= "test";
process.env.ANTHROPIC_API_KEY ??= "test";
process.env.DATABASE_PATH ??= "data/sosoalpha.db";

import Database from "better-sqlite3";
import { resolve } from "node:path";
const conn = new Database(resolve(process.cwd(), process.env.DATABASE_PATH!));
conn.pragma("journal_mode = WAL");

import { _setDatabaseForTests, db } from "../src/lib/db/client";
_setDatabaseForTests(conn);

import { backfillShadowV2 } from "../src/lib/jobs/backfill-shadow";

const before = db()
  .prepare<[], { c: number }>(
    `SELECT COUNT(*) AS c FROM signal_outcomes WHERE framework_version = 'v2'`,
  )
  .get()?.c ?? 0;
console.log(`v2 outcomes BEFORE backfill: ${before}`);

const summary = backfillShadowV2("alphacore", 30, 10_000);
console.log("backfill summary:", summary);

const after = db()
  .prepare<[], { c: number }>(
    `SELECT COUNT(*) AS c FROM signal_outcomes WHERE framework_version = 'v2'`,
  )
  .get()?.c ?? 0;
console.log(`v2 outcomes AFTER backfill: ${after}`);
console.log(`net new: ${after - before}`);

// Idempotence check
const summary2 = backfillShadowV2("alphacore", 30, 10_000);
console.log("\nsecond run (idempotence):", {
  rebalances_written: summary2.rebalances_written,
  outcomes_written: summary2.outcomes_written,
});
