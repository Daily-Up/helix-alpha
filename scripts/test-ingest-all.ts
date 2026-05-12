/**
 * One-shot: run klines + ETF + sectors ingests in sequence.
 *
 *   npm run ingest:all
 *
 * Use this to populate fresh data after pulling latest news.
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const {
    runKlinesIngestWithAudit,
    runETFIngestWithAudit,
    runSectorsSnapshotWithAudit,
  } = await import("../src/lib/ingest");

  console.log("→ Klines (this takes ~60s for 33 tokens with rate-limit safety)");
  const klines = await runKlinesIngestWithAudit({ daysBack: 90 });
  console.log(
    `  ✓ ${klines.candles_upserted} candles across ${klines.assets_processed} assets ` +
      `(${klines.assets_failed} failed) in ${(klines.latency_ms / 1000).toFixed(1)}s`,
  );
  for (const e of klines.errors.slice(0, 3)) {
    console.log(`    ✗ ${e.asset_id}: ${e.error.slice(0, 120)}`);
  }

  console.log("\n→ ETF flows (BTC + ETH aggregate + per-fund)");
  const etf = await runETFIngestWithAudit({ limit: 30 });
  console.log(
    `  ✓ aggs ${etf.agg_rows_upserted} rows / funds ${etf.fund_rows_upserted} rows ` +
      `(failed: ${etf.aggregates_failed + etf.funds_failed})`,
  );
  for (const e of etf.errors.slice(0, 3)) {
    console.log(`    ✗ ${e.key}: ${e.error.slice(0, 120)}`);
  }

  console.log("\n→ Sector snapshot");
  const sec = await runSectorsSnapshotWithAudit();
  console.log(`  ✓ ${sec.sectors_recorded} sectors recorded`);

  console.log("\n✅ All ingests complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
