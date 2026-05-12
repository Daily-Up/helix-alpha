/**
 * Quick read-only peek into the local SQLite DB.
 *
 *   npm run db:stats
 *
 * Prints row counts per table + a few interesting recent rows.
 * Useful when you don't have the sqlite3 CLI installed.
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const { db } = await import("../src/lib/db");
  const conn = db();

  const tables = (
    conn
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);

  console.log("──── Row counts ────");
  for (const t of tables) {
    const n = (conn.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    console.log(`${t.padEnd(28)} ${n}`);
  }

  // Recent classified events
  type Row = {
    id: string;
    release_time: number;
    title: string;
    event_type: string | null;
    sentiment: string | null;
    severity: string | null;
    confidence: number | null;
  };
  const recent = conn
    .prepare(
      `SELECT n.id, n.release_time, n.title,
              c.event_type, c.sentiment, c.severity, c.confidence
       FROM news_events n
       LEFT JOIN classifications c ON c.event_id = n.id
       ORDER BY n.release_time DESC
       LIMIT 10`,
    )
    .all() as Row[];

  console.log("\n──── 10 most recent events ────");
  for (const r of recent) {
    const ts = new Date(r.release_time).toISOString().slice(0, 16).replace("T", " ");
    const tag = r.event_type
      ? `${r.event_type}/${r.sentiment}/${r.severity}@${(r.confidence ?? 0).toFixed(2)}`
      : "(unclassified)";
    console.log(`[${ts}] ${tag.padEnd(30)} ${r.title.slice(0, 70)}`);
  }

  // Cron audit
  type CronRow = { id: number; job: string; status: string; summary: string | null };
  const runs = conn
    .prepare(
      `SELECT id, job, status, summary FROM cron_runs ORDER BY started_at DESC LIMIT 5`,
    )
    .all() as CronRow[];

  console.log("\n──── 5 latest cron runs ────");
  for (const r of runs) {
    console.log(`#${r.id} ${r.job.padEnd(20)} [${r.status}] ${r.summary ?? ""}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
