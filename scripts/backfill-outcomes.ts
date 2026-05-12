/**
 * One-shot backfill: insert signal_outcomes rows for every existing
 * signal that doesn't already have one, then run the resolution job
 * once so any signals with elapsed horizons resolve immediately.
 *
 * Run:  npx tsx scripts/backfill-outcomes.ts
 */

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local"), override: true });

async function main() {
  const { backfillOutcomesForExistingSignals, runResolutionJob } =
    await import("../src/lib/outcomes/resolve-job");

  console.log("[backfill] inserting outcome rows for existing signals…");
  const ins = backfillOutcomesForExistingSignals();
  console.log(JSON.stringify(ins, null, 2));

  console.log("\n[backfill] running resolution job once…");
  const r = runResolutionJob();
  console.log(JSON.stringify(r, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
