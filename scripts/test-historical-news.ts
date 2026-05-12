/**
 * Probe SoSoValue news endpoints for historical depth.
 *
 * Three tests:
 *   1. /news with start_time = 30 days ago → does the API silently clamp
 *      to 7d, or accept the wider window?
 *   2. /news/search with sort=publish_time, then walk pages → how far
 *      back does the index actually go?
 *   3. /news with currency_id filter → is per-asset history deeper?
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

const BASE = process.env.SOSOVALUE_BASE_URL!;
const KEY = process.env.SOSOVALUE_API_KEY!;

async function rawGet(path: string, query: Record<string, string | number> = {}) {
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(query).map(([k, v]) => [k, String(v)]),
    ),
  ).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: { "x-soso-api-key": KEY } });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as Record<string, unknown> };
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function test1_widerWindow() {
  console.log("\n══ TEST 1: /news with 30-day start_time ══");
  const end = Date.now();
  const start = end - 30 * 24 * 60 * 60 * 1000;
  console.log(`Requesting items between ${fmtDate(start)} and ${fmtDate(end)}`);

  const r = await rawGet("/news", {
    start_time: start,
    end_time: end,
    language: "en",
    page: 1,
    page_size: 100,
  });

  if (r.status !== 200) {
    console.log("status", r.status, "→", JSON.stringify(r.body).slice(0, 300));
    return;
  }

  interface List {
    data?: { list?: Array<{ release_time?: number | string }>; total?: number };
  }
  const body = r.body as List;
  const list = body.data?.list ?? [];
  if (list.length === 0) {
    console.log("No items returned.");
    return;
  }

  const times = list
    .map((it) => Number(it.release_time))
    .filter((n) => Number.isFinite(n));
  const oldest = Math.min(...times);
  const newest = Math.max(...times);
  console.log(
    `Returned: ${list.length} items, total claimed: ${body.data?.total ?? "?"}`,
  );
  console.log(`Oldest in batch: ${new Date(oldest).toISOString()}`);
  console.log(`Newest in batch: ${new Date(newest).toISOString()}`);
  const oldestDaysAgo = (end - oldest) / (24 * 60 * 60 * 1000);
  console.log(`Oldest is ${oldestDaysAgo.toFixed(1)} days back.`);
  if (oldestDaysAgo > 8) {
    console.log("✅ The API DID respect the 30-day window!");
  } else {
    console.log("❌ Clamped to ~7 days as documented.");
  }
}

async function test2_searchHistorical() {
  console.log("\n══ TEST 2: /news/search sort=publish_time, deep paging ══");

  // Use a generic, evergreen keyword that will match many items.
  for (const keyword of ["bitcoin", "ethereum"]) {
    console.log(`\n  keyword="${keyword}"`);
    let oldestSeenMs = Infinity;
    let totalCollected = 0;
    let lastPageHadItems = true;
    for (let page = 1; page <= 10 && lastPageHadItems; page++) {
      const r = await rawGet("/news/search", {
        keyword,
        page,
        page_size: 50,
        sort: "publish_time",
      });
      interface List {
        data?: { list?: Array<{ release_time?: number | string }>; total?: number };
      }
      const body = r.body as List;
      const list = body.data?.list ?? [];
      if (list.length === 0) {
        lastPageHadItems = false;
        break;
      }
      totalCollected += list.length;
      for (const it of list) {
        const t = Number(it.release_time);
        if (Number.isFinite(t) && t < oldestSeenMs) oldestSeenMs = t;
      }
      if (list.length < 50) lastPageHadItems = false;
    }

    if (oldestSeenMs === Infinity) {
      console.log("    no items returned");
      continue;
    }
    const daysAgo = (Date.now() - oldestSeenMs) / (24 * 60 * 60 * 1000);
    console.log(
      `    collected ${totalCollected} items, oldest = ${new Date(oldestSeenMs).toISOString()} (${daysAgo.toFixed(1)} days back)`,
    );
  }
}

async function test3_currencyFilter() {
  console.log("\n══ TEST 3: /news with currency_id filter (BTC) ══");
  // Find BTC's currency_id
  const ccyResp = await rawGet("/currencies");
  interface CcyList {
    data?: Array<{ currency_id: string; symbol?: string }>;
  }
  const ccyBody = ccyResp.body as CcyList;
  const ccy = ccyBody.data?.find((c) => c.symbol === "BTC");
  if (!ccy) {
    console.log("Could not find BTC currency_id");
    return;
  }
  console.log(`BTC currency_id = ${ccy.currency_id}`);

  // Same wide-window request but constrained to BTC
  const end = Date.now();
  const start = end - 30 * 24 * 60 * 60 * 1000;
  const r = await rawGet("/news", {
    currency_id: ccy.currency_id,
    start_time: start,
    end_time: end,
    language: "en",
    page: 1,
    page_size: 100,
  });

  if (r.status !== 200) {
    console.log("status", r.status, "→", JSON.stringify(r.body).slice(0, 300));
    return;
  }
  interface List {
    data?: { list?: Array<{ release_time?: number | string }>; total?: number };
  }
  const body = r.body as List;
  const list = body.data?.list ?? [];
  if (list.length === 0) {
    console.log("No items returned.");
    return;
  }
  const times = list
    .map((it) => Number(it.release_time))
    .filter((n) => Number.isFinite(n));
  const oldest = Math.min(...times);
  console.log(
    `Returned ${list.length} items, total claimed: ${body.data?.total ?? "?"}`,
  );
  console.log(
    `Oldest = ${new Date(oldest).toISOString()} (${((end - oldest) / (86400 * 1000)).toFixed(1)} days ago)`,
  );
}

async function main() {
  await test1_widerWindow();
  await test2_searchHistorical();
  await test3_currencyFilter();
  console.log("\n──────────────────────────");
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
