/**
 * Verify the asset universe loads and resolves cleanly against SoSoValue.
 *
 * Prints a coverage report:
 *   - which symbols were resolved
 *   - which are missing (would need to be removed from the universe)
 *
 * Run:
 *   npx tsx scripts/test-universe.ts
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const { DEFAULT_UNIVERSE, resolveUniverse, AssetKind } = await import(
    "../src/lib/universe"
  );

  console.log(`Total universe: ${DEFAULT_UNIVERSE.length} assets\n`);

  const byKind = new Map<string, number>();
  for (const a of DEFAULT_UNIVERSE) {
    byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
  }
  console.log("Breakdown by kind:");
  for (const [k, n] of byKind) console.log(`  ${k.padEnd(15)} ${n}`);
  console.log("");

  console.log("Resolving token + RWA currency_ids against /currencies...\n");
  const resolved = await resolveUniverse(DEFAULT_UNIVERSE);

  const tokens = resolved.filter(
    (a) => a.kind === AssetKind.Token || a.kind === AssetKind.RWA,
  );
  console.log(`✓ ${tokens.length} of ${
    DEFAULT_UNIVERSE.filter(
      (a) => a.kind === AssetKind.Token || a.kind === AssetKind.RWA,
    ).length
  } token/RWA assets resolved`);

  console.log("\nResolved sample:");
  for (const a of tokens.slice(0, 5)) {
    if (a.sosovalue.kind === "token" || a.sosovalue.kind === "rwa") {
      console.log(
        `  ${a.symbol.padEnd(8)} ${a.sosovalue.currency_id}  ${a.name}`,
      );
    }
  }

  const dropped = DEFAULT_UNIVERSE.length - resolved.length;
  if (dropped > 0) {
    console.log(`\n⚠ Dropped ${dropped} asset(s) — see warnings above.`);
  } else {
    console.log(`\n✅ Full universe resolved.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
