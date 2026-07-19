/**
 * One-off: run the token-unlock ingest against the DB in .env.local (prod
 * Turso). Populates the /unlocks calendar. Idempotent. The short trade plan
 * (eligibility, entry/cover timing) is computed at read time from each row,
 * so there's nothing to "generate" — refreshing the calendar is enough.
 *
 *   npx tsx scripts/ingest-unlocks-once.ts
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const { runUnlocksIngestWithAudit } = await import("../src/lib/ingest");

  console.log("→ ingesting token unlocks (DefiLlama)…");
  const ingest = await runUnlocksIngestWithAudit({});
  console.log("INGEST:", JSON.stringify(ingest, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
