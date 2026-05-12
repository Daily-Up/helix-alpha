/**
 * Backfill news_events using SoSoValue's /news/search endpoint.
 *
 * Why: the /news feed is capped at 7 days of history. /news/search has no
 * documented date limit, so keyword queries pull a much deeper sample.
 *
 *   npm run backfill:news
 *   npm run backfill:news -- --pages=3 --pageSize=50
 *
 * Each keyword gets ~2 pages × 50 items = up to 100 candidates. After
 * dedup against existing news_events you typically get ~50-70 net new
 * events per keyword.
 *
 * News items are stored RAW (no classification yet). Run
 * `npm run reclassify -- --force --limit=NNN` afterward to classify them.
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

function arg(name: string, fallback?: string): string | undefined {
  const flag = `--${name}=`;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(flag)) return a.slice(flag.length);
  }
  return fallback;
}

/** Curated keyword groups by event_type. Each group's hits help that pattern. */
const KEYWORDS: Array<{ category: string; queries: string[] }> = [
  {
    category: "exploit",
    queries: ["exploit", "hack", "drained", "stolen", "vulnerability"],
  },
  {
    category: "listing",
    queries: ["listing", "delisting", "Binance lists", "Coinbase lists"],
  },
  {
    category: "regulatory",
    queries: ["SEC", "CFTC", "ban", "regulatory", "DOJ", "Treasury Department"],
  },
  {
    category: "earnings",
    queries: [
      "earnings report",
      "Q1 earnings",
      "Q2 earnings",
      "net loss",
      "revenue",
    ],
  },
  {
    category: "treasury",
    queries: [
      "MicroStrategy buys",
      "Bitcoin treasury",
      "Strategy treasury",
      "balance sheet bitcoin",
    ],
  },
  {
    category: "etf_flow",
    queries: [
      "spot ETF",
      "ETF inflow",
      "ETF outflow",
      "BlackRock IBIT",
      "Fidelity FBTC",
    ],
  },
  {
    category: "partnership",
    queries: ["partnership", "integration", "acquires", "collaboration"],
  },
  {
    category: "macro",
    queries: [
      "FOMC",
      "Powell",
      "rate cut",
      "CPI",
      "jobs report",
      "Federal Reserve",
    ],
  },
  {
    category: "unlock",
    queries: ["token unlock", "vesting", "cliff"],
  },
  {
    category: "airdrop",
    queries: ["airdrop announcement", "claim airdrop"],
  },
  {
    category: "social_platform",
    queries: ["X API", "Twitter ban", "Discord seizure"],
  },
  {
    category: "fundraising",
    queries: ["raises Series", "seed round", "funding round"],
  },
];

async function main() {
  const sv = await import("../src/lib/sosovalue");
  const { Events, Assets } = await import("../src/lib/db");
  const { DEFAULT_UNIVERSE, resolveUniverse } = await import(
    "../src/lib/universe"
  );

  const pages = Number(arg("pages") ?? 2);
  const pageSize = Number(arg("pageSize") ?? 50);

  // Make sure the universe is seeded so matched_currencies → asset_id works.
  if (Assets.getAllAssets().length === 0) {
    console.log("→ Seeding universe (first run)...");
    const r = await resolveUniverse(DEFAULT_UNIVERSE);
    Assets.upsertAssets(r);
  }

  const t0 = Date.now();
  let totalFetched = 0;
  let totalNew = 0;
  let totalQueries = 0;

  for (const group of KEYWORDS) {
    let groupNew = 0;
    let groupFetched = 0;

    for (const keyword of group.queries) {
      for (let page = 1; page <= pages; page++) {
        try {
          totalQueries++;
          const r = await sv.News.searchNews({
            keyword,
            page,
            page_size: pageSize,
            sort: "publish_time",
          });
          const items = r.list ?? [];
          if (items.length === 0) break;
          groupFetched += items.length;

          for (const item of items) {
            const { inserted } = Events.upsertEvent(item);
            if (inserted) {
              groupNew++;
              // Link matched_currencies → asset_ids as 'matched'.
              const ids: string[] = [];
              for (const c of item.matched_currencies ?? []) {
                const asset = Assets.getAssetByCurrencyId(c.currency_id);
                if (asset) ids.push(asset.id);
              }
              if (ids.length) Events.linkEventAssets(item.id, ids, "matched");
            }
          }
          // Global rate limiter inside sosoGet handles throttling — no
          // explicit sleep needed here.
        } catch (err) {
          console.warn(
            `  ! "${keyword}" p${page}: ${(err as Error).message.slice(0, 80)}`,
          );
        }
      }
    }

    totalFetched += groupFetched;
    totalNew += groupNew;
    console.log(
      `[${group.category.padEnd(15)}] fetched=${groupFetched} new=${groupNew}`,
    );
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log("\n" + "─".repeat(60));
  console.log(
    `Total queries: ${totalQueries}\n` +
      `Total fetched: ${totalFetched}\n` +
      `Total new events: ${totalNew}\n` +
      `Elapsed: ${elapsed}s`,
  );
  console.log(
    `\nNext step: npm run reclassify -- --limit=${Math.min(totalNew + 100, 500)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
