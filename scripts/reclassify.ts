/**
 * CLI: re-classify events whose prompt_version is older than the current one.
 *
 *   npm run reclassify              # everything stale (uses CLASSIFY_PROMPT_VERSION)
 *   npm run reclassify -- --force   # re-run all events (overwrites)
 *   npm run reclassify -- --limit=50
 *
 * Shows live per-event progress + cost so you don't have to stare at a
 * loading browser tab.
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

function arg(name: string, fallback?: string): string | undefined {
  const flag = `--${name}=`;
  for (const a of process.argv.slice(2)) if (a.startsWith(flag)) return a.slice(flag.length);
  if (process.argv.includes(`--${name}`)) return "true";
  return fallback;
}

async function main() {
  const { db } = await import("../src/lib/db");
  const { classifyEvent, CLASSIFY_PROMPT_VERSION } = await import(
    "../src/lib/ai"
  );
  const { Events } = await import("../src/lib/db");

  const force = arg("force") === "true";
  // --oldest = process oldest unclassified first. Useful when you've
  // already classified the recent batch and now want historical events
  // for impact analysis.
  const oldest = arg("oldest") === "true";
  const limit = Number(arg("limit") ?? 100);
  const order = oldest ? "ASC" : "DESC";

  interface Row {
    id: string;
  }
  const rows: Row[] = force
    ? db()
        .prepare<[number], Row>(
          `SELECT n.id FROM news_events n
           LEFT JOIN classifications c ON c.event_id = n.id
           ORDER BY n.release_time ${order} LIMIT ?`,
        )
        .all(limit)
    : db()
        .prepare<[string, number], Row>(
          `SELECT n.id FROM news_events n
           LEFT JOIN classifications c ON c.event_id = n.id
           WHERE c.event_id IS NULL
              OR c.prompt_version IS NULL
              OR c.prompt_version != ?
           ORDER BY n.release_time ${order} LIMIT ?`,
        )
        .all(CLASSIFY_PROMPT_VERSION, limit);

  console.log(
    `→ Found ${rows.length} events to reclassify ` +
      `(prompt_version=${CLASSIFY_PROMPT_VERSION}${force ? ", force=ON" : ""})`,
  );
  if (rows.length === 0) {
    console.log("✅ Nothing to do. All events are on the current prompt.");
    return;
  }

  let i = 0;
  let okN = 0;
  let errN = 0;
  let totalIn = 0;
  let totalOut = 0;
  let totalCached = 0;
  const t0 = Date.now();

  for (const row of rows) {
    i++;
    const evt = Events.getEventById(row.id);
    if (!evt) {
      errN++;
      console.log(`[${i}/${rows.length}] ✗ event ${row.id} missing`);
      continue;
    }
    try {
      const r = await classifyEvent(evt);
      okN++;
      totalIn += r.tokens.input;
      totalOut += r.tokens.output;
      totalCached += r.tokens.cached;
      const tag = r.actionable ? "ACT" : "···";
      const tone =
        r.sentiment === "positive"
          ? "+"
          : r.sentiment === "negative"
            ? "-"
            : "·";
      console.log(
        `[${String(i).padStart(3)}/${rows.length}] ${tag} ${tone} ` +
          `${r.event_type.padEnd(15)} ${r.event_recency.padEnd(10)} ` +
          `conf=${(r.confidence * 100).toFixed(0).padStart(3)}%  ` +
          `${evt.title.slice(0, 60)}`,
      );
    } catch (err) {
      errN++;
      console.log(
        `[${i}/${rows.length}] ✗ ${evt.id}: ${(err as Error).message.slice(0, 80)}`,
      );
    }
  }

  const cost =
    (totalIn * 3 + totalCached * 0.3 + totalOut * 15) / 1_000_000;
  const elapsed = (Date.now() - t0) / 1000;
  console.log("\n" + "─".repeat(60));
  console.log(
    `✓ ${okN} reclassified · ✗ ${errN} errors · ` +
      `${elapsed.toFixed(0)}s · cost ~$${cost.toFixed(4)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
