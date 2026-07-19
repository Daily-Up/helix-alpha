/**
 * One-off: run the token-unlock ingest + short-signal generation against the
 * DB in .env.local (prod Turso). Populates the /unlocks calendar and fires
 * shorts for near-term unlocks. Idempotent.
 *
 *   npx tsx scripts/ingest-unlocks-once.ts
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const { runUnlocksIngestWithAudit } = await import("../src/lib/ingest");
  const { generateUnlockSignalsWithAudit } = await import(
    "../src/lib/trading/unlock-signals"
  );

  console.log("→ ingesting token unlocks (DefiLlama)…");
  const ingest = await runUnlocksIngestWithAudit({});
  console.log("INGEST:", JSON.stringify(ingest, null, 2));

  console.log("→ generating short signals…");
  const signals = await generateUnlockSignalsWithAudit({});
  console.log("SIGNALS:", JSON.stringify(signals, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
