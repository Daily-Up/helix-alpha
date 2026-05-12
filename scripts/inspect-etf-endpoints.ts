/**
 * Investigate the /etfs and /etfs/summary-history endpoints — both return
 * HTTP 400 unless we send the right query params. Try every reasonable
 * variant and dump what comes back.
 *
 * Run:
 *   npx tsx scripts/inspect-etf-endpoints.ts
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

const BASE = process.env.SOSOVALUE_BASE_URL!;
const KEY = process.env.SOSOVALUE_API_KEY!;

async function tryGet(label: string, path: string, q: Record<string, string>) {
  const qs = new URLSearchParams(q).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: { "x-soso-api-key": KEY } });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  const ok = res.status === 200;
  console.log(
    `\n[${ok ? "✓" : "✗"} ${res.status}] ${label}\n  ${url}\n  ${JSON.stringify(parsed).slice(0, 400)}`,
  );
  return { ok, body: parsed };
}

async function main() {
  console.log("Investigating /etfs variants...\n");

  await tryGet("/etfs no params", "/etfs", {});
  await tryGet("/etfs asset=BTC", "/etfs", { asset: "BTC" });
  await tryGet("/etfs asset=btc", "/etfs", { asset: "btc" });
  await tryGet("/etfs underlying=BTC", "/etfs", { underlying: "BTC" });
  await tryGet("/etfs symbol=BTC", "/etfs", { symbol: "BTC" });
  await tryGet("/etfs type=spot", "/etfs", { type: "spot" });
  await tryGet("/etfs etf_type=us-btc-spot", "/etfs", { etf_type: "us-btc-spot" });
  await tryGet("/etfs category=us-btc-spot", "/etfs", { category: "us-btc-spot" });

  // Try common URL patterns we saw in the website's URLs
  await tryGet("/etfs/us-btc-spot", "/etfs/us-btc-spot", {});
  await tryGet("/etfs/list?asset=BTC", "/etfs/list", { asset: "BTC" });

  console.log("\nInvestigating /etfs/summary-history variants...\n");

  await tryGet("summary-history no params", "/etfs/summary-history", {});
  await tryGet("summary-history asset=BTC", "/etfs/summary-history", {
    asset: "BTC",
  });
  await tryGet("summary-history asset=BTC + limit", "/etfs/summary-history", {
    asset: "BTC",
    limit: "10",
  });
  await tryGet(
    "summary-history asset=BTC + start/end",
    "/etfs/summary-history",
    {
      asset: "BTC",
      start_time: String(Date.now() - 30 * 24 * 60 * 60 * 1000),
      end_time: String(Date.now()),
    },
  );
  await tryGet("summary-history etf_type=us-btc-spot", "/etfs/summary-history", {
    etf_type: "us-btc-spot",
  });
  await tryGet("summary-history category=us-btc-spot", "/etfs/summary-history", {
    category: "us-btc-spot",
  });
  await tryGet("summary-history underlying=BTC", "/etfs/summary-history", {
    underlying: "BTC",
  });

  // Try a single-fund history (we know IBIT exists)
  console.log("\nTrying single-fund endpoints...\n");
  await tryGet("/etfs/IBIT/market-snapshot", "/etfs/IBIT/market-snapshot", {});
  await tryGet("/etfs/IBIT/history", "/etfs/IBIT/history", {});
  await tryGet("/etfs/IBIT/history limit=10", "/etfs/IBIT/history", {
    limit: "10",
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
