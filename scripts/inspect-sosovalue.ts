/**
 * Diagnostic: dump RAW first response from each SoSoValue endpoint
 * so we can see the actual field names (docs are not fully accurate).
 *
 * Run:
 *   npx tsx scripts/inspect-sosovalue.ts
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

const BASE = process.env.SOSOVALUE_BASE_URL!;
const KEY = process.env.SOSOVALUE_API_KEY!;

async function rawGet(path: string, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: { "x-soso-api-key": KEY } });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function dumpFirstItem(label: string, body: unknown) {
  console.log(`\n══ ${label} ══`);
  console.log("type:", typeof body);

  // Walk into common envelopes
  let target: unknown = body;
  if (target && typeof target === "object" && "data" in target) {
    target = (target as { data: unknown }).data;
    console.log("(unwrapped from .data)");
  }
  if (target && typeof target === "object" && "list" in target) {
    const t = target as { list?: unknown[]; total?: number; page?: number };
    console.log("envelope:", { total: t.total, page: t.page, listLen: t.list?.length });
    target = t.list?.[0];
    console.log("(taking list[0])");
  } else if (Array.isArray(target)) {
    console.log(`array len=${target.length}`);
    target = target[0];
    console.log("(taking [0])");
  }

  console.log("first item keys:", target && typeof target === "object" ? Object.keys(target) : target);
  console.log("first item:", JSON.stringify(target, null, 2)?.slice(0, 2000));
}

async function main() {
  console.log("Inspecting SoSoValue endpoints...");

  // 1) /currencies
  const currencies = await rawGet("/currencies");
  console.log("\n/currencies status:", currencies.status);
  dumpFirstItem("/currencies", currencies.body);

  // 2) /news (last 24h)
  const end = Date.now();
  const start = end - 24 * 60 * 60 * 1000;
  const news = await rawGet("/news", {
    page: "1",
    page_size: "3",
    start_time: String(start),
    end_time: String(end),
    language: "en",
  });
  console.log("\n/news status:", news.status);
  dumpFirstItem("/news", news.body);

  // 3) /etfs
  const etfs = await rawGet("/etfs");
  console.log("\n/etfs status:", etfs.status);
  dumpFirstItem("/etfs", etfs.body);

  // 4) /etfs/summary-history (BTC)
  const etfHist = await rawGet("/etfs/summary-history", { asset: "BTC", limit: "3" });
  console.log("\n/etfs/summary-history?asset=BTC status:", etfHist.status);
  dumpFirstItem("/etfs/summary-history", etfHist.body);

  // 5) /indices
  const indices = await rawGet("/indices");
  console.log("\n/indices status:", indices.status);
  dumpFirstItem("/indices", indices.body);

  // 6) /crypto-stocks
  const stocks = await rawGet("/crypto-stocks");
  console.log("\n/crypto-stocks status:", stocks.status);
  dumpFirstItem("/crypto-stocks", stocks.body);

  // 7) /currencies/sector-spotlight
  const sector = await rawGet("/currencies/sector-spotlight");
  console.log("\n/currencies/sector-spotlight status:", sector.status);
  console.log("body sample:", JSON.stringify(sector.body, null, 2)?.slice(0, 1500));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
