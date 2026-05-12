/**
 * Debug: walk every actionable, recent classification and explain why it
 * did or did not produce a signal.
 *
 * Run:
 *   npm run debug:signals
 *
 * Helps tune affected_asset_ids quality + tradability mapping.
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const { db, Assets } = await import("../src/lib/db");

  interface Row {
    event_id: string;
    title: string;
    release_time: number;
    event_type: string;
    sentiment: string;
    severity: string;
    confidence: number;
    actionable: number | null;
    event_recency: string | null;
    affected_asset_ids: string;
  }

  const since = Date.now() - 72 * 60 * 60 * 1000;
  const rows = db()
    .prepare<[number], Row>(
      `SELECT n.id AS event_id, n.title, n.release_time,
              c.event_type, c.sentiment, c.severity, c.confidence,
              c.actionable, c.event_recency, c.affected_asset_ids
       FROM classifications c
       JOIN news_events n ON n.id = c.event_id
       WHERE n.release_time >= ?
       ORDER BY n.release_time DESC`,
    )
    .all(since);

  console.log(`Inspecting ${rows.length} classifications from last 72h...\n`);

  let actionableLiveCount = 0;
  let withTradable = 0;

  for (const r of rows) {
    if (r.actionable !== 1) continue;
    if (r.event_recency !== "live" && r.event_recency !== "today") continue;
    actionableLiveCount++;

    const affectedIds = JSON.parse(r.affected_asset_ids) as string[];
    const tradableIds: string[] = [];
    const nonTradableIds: string[] = [];
    for (const id of affectedIds) {
      const asset = Assets.getAssetById(id);
      if (!asset) {
        nonTradableIds.push(`${id} [NOT IN UNIVERSE]`);
      } else if (asset.tradable) {
        tradableIds.push(`${id} → ${asset.tradable.symbol}`);
      } else {
        nonTradableIds.push(`${id} [not tradable]`);
      }
    }

    if (tradableIds.length > 0) withTradable++;

    const tag = tradableIds.length > 0 ? "✓" : "✗";
    const time = new Date(r.release_time).toISOString().slice(11, 16);
    console.log(
      `${tag} [${time}] ${r.event_type.padEnd(12)} sev=${r.severity.padEnd(6)} conf=${(r.confidence * 100).toFixed(0)}%  ${r.title.slice(0, 75)}`,
    );
    if (tradableIds.length > 0) {
      console.log(`     trades: ${tradableIds.join(", ")}`);
    }
    if (nonTradableIds.length > 0) {
      console.log(`     skipped: ${nonTradableIds.join(", ")}`);
    }
    console.log();
  }

  console.log("─".repeat(70));
  console.log(
    `Total recent classifications: ${rows.length}\n` +
      `Actionable + live/today: ${actionableLiveCount}\n` +
      `Of those, with tradable affected asset: ${withTradable}\n` +
      `Should have produced signals: ${withTradable}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
