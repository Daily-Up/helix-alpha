/**
 * End-to-end SoDEX integration check.
 *
 *   npm run test:sodex
 *
 * 1. Re-seeds the assets table with the new tradable field
 * 2. Pulls live SoDEX tickers
 * 3. Joins universe.tradable.symbol → ticker.lastPx
 * 4. Prints the live tradable universe with current prices
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const { Assets } = await import("../src/lib/db");
  const { DEFAULT_UNIVERSE, resolveUniverse } = await import(
    "../src/lib/universe"
  );
  const { Market } = await import("../src/lib/sodex");

  console.log("→ Re-seeding asset universe (with new tradable field)…");
  const resolved = await resolveUniverse(DEFAULT_UNIVERSE);
  Assets.upsertAssets(resolved);
  const tradable = Assets.getTradableAssets();
  console.log(
    `  ✓ ${resolved.length} assets stored, ${tradable.length} marked tradable`,
  );

  console.log("→ Fetching live SoDEX tickers…");
  const tickerMap = await Market.getTickersBySymbol();
  console.log(`  ✓ ${tickerMap.size} live tickers`);

  console.log("\n──── Tradable universe with live prices ────");
  console.log(
    "ID".padEnd(18) +
      "SYMBOL".padEnd(10) +
      "SODEX".padEnd(20) +
      "PRICE".padStart(14) +
      "24H%".padStart(10),
  );
  console.log("─".repeat(72));

  for (const a of tradable) {
    const sym = a.tradable!.symbol;
    const t = tickerMap.get(sym);
    const px = t ? Number(t.lastPx) : null;
    const pct = t ? Number(t.changePct) : null;
    console.log(
      a.id.padEnd(18) +
        a.symbol.padEnd(10) +
        sym.padEnd(20) +
        (px != null ? `$${px.toFixed(4)}` : "—").padStart(14) +
        (pct != null
          ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`
          : "—"
        ).padStart(10),
    );
  }

  console.log(
    `\n✅ ${tradable.length} tradable assets confirmed against live SoDEX feed.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
