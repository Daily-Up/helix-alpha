/**
 * One-shot: populate ETF flows, macro, treasuries, and sectors on the
 * current DB (used after the Turso migration left these tables empty).
 * Mirrors the four cron endpoints the helix-data-refresh workflow hits,
 * but runs in a single local process against .env.local.
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local"), override: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const {
    runETFIngestWithAudit,
    runMacroIngestWithAudit,
    runTreasuriesIngestWithAudit,
    runSectorsSnapshotWithAudit,
  } = await import("../src/lib/ingest");

  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const t = Date.now();
      const r = await fn();
      console.log(`✅ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s):`, JSON.stringify(r).slice(0, 300));
    } catch (e) {
      console.log(`❌ ${name}:`, (e as Error).message);
    }
  };

  await step("ETF flows", () => runETFIngestWithAudit({}));
  await sleep(3000);
  await step("Macro", () => runMacroIngestWithAudit({ delayMs: 250 }));
  await sleep(3000);
  await step("Treasuries", () => runTreasuriesIngestWithAudit({ delayMs: 250, maxCompanies: 25 }));
  await sleep(3000);
  await step("Sectors", () => runSectorsSnapshotWithAudit());
}

main().catch((e) => { console.error(e); process.exit(1); });
