/**
 * Debug: peek at what's actually in impact_metrics and why the patterns
 * query might be returning empty.
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const { db } = await import("../src/lib/db");
  const conn = db();

  const counts = conn
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN impact_pct_1d IS NOT NULL THEN 1 ELSE 0 END) AS with_1d,
         SUM(CASE WHEN impact_pct_3d IS NOT NULL THEN 1 ELSE 0 END) AS with_3d,
         SUM(CASE WHEN impact_pct_7d IS NOT NULL THEN 1 ELSE 0 END) AS with_7d,
         SUM(CASE WHEN price_t0 IS NOT NULL THEN 1 ELSE 0 END) AS with_t0
       FROM impact_metrics`,
    )
    .get();
  console.log("impact_metrics summary:");
  console.log(counts);

  console.log("\nJoin with classifications (the patterns query):");
  const joined = conn
    .prepare(
      `SELECT
         COUNT(*) AS rows_joined,
         SUM(CASE WHEN im.impact_pct_1d IS NOT NULL THEN 1 ELSE 0 END) AS with_1d
       FROM impact_metrics im
       JOIN classifications c ON c.event_id = im.event_id`,
    )
    .get();
  console.log(joined);

  console.log("\nSample rows from impact_metrics (last 10):");
  const rows = conn
    .prepare(
      `SELECT event_id, asset_id, price_t0, price_t1d, impact_pct_1d, impact_pct_3d, impact_pct_7d
       FROM impact_metrics
       ORDER BY computed_at DESC
       LIMIT 10`,
    )
    .all();
  for (const r of rows) console.log(r);

  console.log("\nKlines availability per asset (first 10):");
  const klines = conn
    .prepare(
      `SELECT asset_id, COUNT(*) AS days, MIN(date) AS earliest, MAX(date) AS latest
       FROM klines_daily
       GROUP BY asset_id
       ORDER BY days DESC
       LIMIT 10`,
    )
    .all();
  for (const r of klines) console.log(r);

  console.log("\nClassification counts by prompt_version:");
  const versions = conn
    .prepare(
      `SELECT prompt_version, COUNT(*) AS n FROM classifications GROUP BY prompt_version`,
    )
    .all();
  for (const r of versions) console.log(r);

  console.log("\nGrouped patterns query (1d):");
  const patterns = conn
    .prepare(
      `SELECT c.event_type, c.sentiment, COUNT(*) AS n,
              ROUND(AVG(im.impact_pct_1d), 2) AS avg_pct
       FROM impact_metrics im
       JOIN classifications c ON c.event_id = im.event_id
       WHERE im.impact_pct_1d IS NOT NULL
       GROUP BY c.event_type, c.sentiment
       ORDER BY n DESC`,
    )
    .all();
  if (patterns.length === 0) {
    console.log("  (NO ROWS — this is why /patterns shows empty)");
  }
  for (const p of patterns) console.log(p);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
