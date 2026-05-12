/**
 * One-time backfill: stamp a sentinel `significance_score = 0` on every
 * pre-deployment signal row that pre-dates the significance pipeline.
 *
 * Rationale: invariant I-45 requires every persisted signal to carry a
 * non-null significance_score. Existing historical rows (the 41 signals
 * that fired before Phase C deployment) have NULL. Deleting them would
 * destroy v1's outcome history, so we stamp them with a sentinel value
 * (0) and tag the reasoning column with a marker so calibration audits
 * can exclude them from significance-related stats.
 *
 * Idempotent: only touches rows where significance_score IS NULL.
 *
 * Usage: npx tsx scripts/backfill-significance.ts
 */

import { db } from "../src/lib/db";

const SENTINEL_NOTE = "[pre-significance-deployment: significance_score backfilled to 0]";

const stmt = db().prepare<[string, string], { changes: number }>(
  `UPDATE signals
     SET significance_score = 0,
         reasoning = reasoning || ?
   WHERE significance_score IS NULL
     AND reasoning NOT LIKE ?`,
);
// SQLite UPDATE doesn't return rowcount through prepare; use better-sqlite3 .run().
const res = db()
  .prepare(
    `UPDATE signals
       SET significance_score = 0,
           reasoning = reasoning || ?
     WHERE significance_score IS NULL
       AND reasoning NOT LIKE ?`,
  )
  .run(`\n\n${SENTINEL_NOTE}`, `%${SENTINEL_NOTE}%`);
void stmt;

const verify = db()
  .prepare<[], { n: number }>(
    `SELECT COUNT(*) AS n FROM signals WHERE significance_score IS NULL`,
  )
  .get();

console.log(`[backfill] updated ${res.changes} pre-deployment signal rows`);
console.log(`[backfill] remaining NULL significance_score: ${verify?.n ?? "?"}`);
if ((verify?.n ?? 0) > 0) {
  console.error(
    `[backfill] WARNING: NULL rows remain — significance pipeline must be missing on these.`,
  );
  process.exit(1);
}
console.log(`[backfill] OK — invariant I-45 satisfied across all signal rows.`);
