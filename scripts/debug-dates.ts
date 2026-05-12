/**
 * Show the date distribution of events so we can understand why impact_1d
 * is null for everything (probably: too many events are from today/yesterday).
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const { db } = await import("../src/lib/db");
  const conn = db();

  console.log("Today UTC:", new Date().toISOString().slice(0, 10));
  console.log();

  console.log("Event count by day (last 14 days):");
  const byDay = conn
    .prepare(
      `SELECT date(release_time / 1000, 'unixepoch') AS day,
              COUNT(*) AS n
       FROM news_events
       WHERE release_time >= ?
       GROUP BY day
       ORDER BY day DESC`,
    )
    .all(Date.now() - 14 * 24 * 60 * 60 * 1000);
  for (const r of byDay) console.log(" ", r);

  console.log("\nOldest events:");
  const oldest = conn
    .prepare(
      `SELECT date(release_time / 1000, 'unixepoch') AS day,
              n.title
       FROM news_events n
       ORDER BY release_time ASC
       LIMIT 5`,
    )
    .all();
  for (const r of oldest) console.log(" ", r);

  console.log("\nSample of events with impact_pct_1d=NULL — release_time check:");
  const rows = conn
    .prepare(
      `SELECT date(n.release_time / 1000, 'unixepoch') AS day,
              im.asset_id,
              im.price_t0,
              im.price_t1d
       FROM impact_metrics im
       JOIN news_events n ON n.id = im.event_id
       WHERE im.impact_pct_1d IS NULL
       ORDER BY n.release_time DESC
       LIMIT 10`,
    )
    .all();
  for (const r of rows) console.log(" ", r);

  console.log("\nEvents released >2 days ago — should have impact_1d:");
  const old = conn
    .prepare<[number], { n: number }>(
      `SELECT COUNT(*) AS n FROM news_events WHERE release_time < ?`,
    )
    .get(Date.now() - 2 * 24 * 60 * 60 * 1000);
  console.log(" total events older than 2 days:", old?.n);

  console.log("\nOf those, how many have classifications + linked tokens?");
  const linked = conn
    .prepare<[number], { n: number }>(
      `SELECT COUNT(DISTINCT n.id) AS n
       FROM news_events n
       JOIN classifications c ON c.event_id = n.id
       JOIN event_assets ea ON ea.event_id = n.id
       JOIN assets a ON a.id = ea.asset_id
       WHERE n.release_time < ?
         AND a.kind IN ('token', 'rwa')`,
    )
    .get(Date.now() - 2 * 24 * 60 * 60 * 1000);
  console.log(" classifiable + tradable:", linked?.n);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
