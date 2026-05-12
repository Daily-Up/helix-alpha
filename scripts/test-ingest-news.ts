/**
 * End-to-end news ingest run from CLI.
 *
 *   npm run ingest:news -- --window=3600000 --max=20
 *
 * Useful for backfills and debugging without spinning up Next.js.
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

function arg(name: string, fallback?: string): string | undefined {
  const flag = `--${name}=`;
  for (const a of process.argv.slice(2)) if (a.startsWith(flag)) return a.slice(flag.length);
  return fallback;
}

async function main() {
  const { Assets } = await import("../src/lib/db");
  const { DEFAULT_UNIVERSE, resolveUniverse } = await import(
    "../src/lib/universe"
  );
  const { runNewsIngestWithAudit } = await import("../src/lib/ingest");

  // Ensure assets are seeded.
  if (Assets.getAllAssets().length === 0) {
    console.log("→ Seeding asset universe (first run)...");
    const r = await resolveUniverse(DEFAULT_UNIVERSE);
    Assets.upsertAssets(r);
  }

  const opts = {
    windowMs: arg("window") ? Number(arg("window")) : 60 * 60 * 1000,
    maxItems: arg("max") ? Number(arg("max")) : 50,
    skipClassify: arg("skip-classify") === "1",
    reclassify: arg("reclassify") === "1",
  };

  console.log(`→ Running ingest with`, opts);
  const summary = await runNewsIngestWithAudit(opts);

  console.log("\n──── INGEST SUMMARY ────");
  console.log(`fetched:               ${summary.fetched}`);
  console.log(`new events:            ${summary.new_events}`);
  console.log(`classified:            ${summary.classified}`);
  console.log(`classification errors: ${summary.classification_errors}`);
  console.log(
    `tokens:                fresh-in=${summary.tokens.input}  cached-in=${summary.tokens.cached}  out=${summary.tokens.output}`,
  );
  console.log(`approx cost:           $${summary.cost_usd.toFixed(4)}`);
  console.log(`latency:               ${(summary.latency_ms / 1000).toFixed(1)}s`);
  console.log(`audit run id:          ${summary.run_id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
