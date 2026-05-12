/**
 * Bootstrap the SQLite DB, sync the asset universe into it,
 * then probe a few representative reads to verify everything wires up.
 *
 * Run:
 *   npm run test:db
 *
 * Effect: creates ./data/sosoalpha.db with the full schema and seeds
 * the assets table from DEFAULT_UNIVERSE (resolved against SoSoValue).
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const { db, Assets, Cron } = await import("../src/lib/db");
  const { DEFAULT_UNIVERSE, resolveUniverse } = await import(
    "../src/lib/universe"
  );

  console.log("→ Connecting to DB + bootstrapping schema...");
  const conn = db();
  const tableCount = (
    conn
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      )
      .get() as { n: number }
  ).n;
  console.log(`  ✓ ${tableCount} tables ready`);

  console.log("→ Resolving universe against SoSoValue...");
  const resolved = await resolveUniverse(DEFAULT_UNIVERSE);
  console.log(`  ✓ ${resolved.length} assets resolved`);

  console.log("→ Upserting assets into DB...");
  await Cron.recordRun("ingest_news", async () => {
    Assets.upsertAssets(resolved);
    return { summary: `seeded ${resolved.length} assets` };
  });

  // Verify reads
  const all = Assets.getAllAssets();
  console.log(`  ✓ ${all.length} assets stored`);

  const btc = Assets.getAssetByCurrencyId("1673723677362319866");
  console.log(
    `  BTC lookup → ${btc ? `${btc.symbol} (${btc.name}, kind=${btc.kind})` : "NOT FOUND"}`,
  );

  const stocks = Assets.getAssetsByKind("stock");
  console.log(`  stock count: ${stocks.length}`);

  const ibit = Assets.getAssetByTicker("IBIT");
  console.log(`  IBIT lookup → ${ibit ? ibit.name : "NOT FOUND"}`);

  // Cron audit
  const last = Cron.lastRun("ingest_news");
  console.log(
    `  last cron → status=${last?.status} summary="${last?.summary}"`,
  );

  console.log("\n✅ DB smoke test complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
