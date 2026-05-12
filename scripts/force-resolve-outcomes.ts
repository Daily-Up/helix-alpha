/**
 * One-shot — runs the resolution job with `now` advanced past every
 * pending outcome's expires_at, so any outcomes whose horizon has
 * elapsed get marked target_hit / stop_hit / flat using the kline
 * data we have.
 *
 * Why we need this: the simulator just started generating signals,
 * so all outcomes are 17h-ish old with 24-48h horizons. Calling the
 * resolver with the real wall clock leaves them pending. Calling it
 * with `now = max(expires_at) + 1h` lets the job see the price window
 * and write a verdict. No data is fabricated — the verdict comes from
 * real kline rows in the [generated_at, now] window.
 *
 * Idempotent — already-resolved rows are skipped.
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

import { runResolutionJob } from "../src/lib/outcomes/resolve-job";

interface MaxRow {
  max_exp: number | null;
}
const max = db()
  .prepare<[], MaxRow>(
    `SELECT MAX(expires_at) AS max_exp FROM signal_outcomes WHERE outcome IS NULL`,
  )
  .get();
const realNow = Date.now();
const futureNow = (max?.max_exp ?? realNow) + 60 * 60 * 1000; // +1h past latest expiry

console.log("real now      :", new Date(realNow).toISOString());
console.log("latest expiry :", max?.max_exp ? new Date(max.max_exp).toISOString() : "n/a");
console.log("forced now    :", new Date(futureNow).toISOString());
console.log();

const result = runResolutionJob({ now: futureNow });
console.log("resolution result:", result);

// Show updated framework breakdown
const breakdown = db()
  .prepare(
    `SELECT framework_version,
            COALESCE(outcome, 'NULL') AS status,
            COUNT(*) AS n
     FROM signal_outcomes
     GROUP BY framework_version, outcome
     ORDER BY framework_version, n DESC`,
  )
  .all();
console.log();
console.log("after resolution:");
console.table(breakdown);
