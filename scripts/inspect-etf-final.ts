/**
 * Final ETF endpoint check — try symbol + country_code combo on the
 * aggregate endpoints, since the error message says both are required.
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

const BASE = process.env.SOSOVALUE_BASE_URL!;
const KEY = process.env.SOSOVALUE_API_KEY!;

async function tryGet(label: string, path: string, q: Record<string, string>) {
  const url = `${BASE}${path}?${new URLSearchParams(q).toString()}`;
  const res = await fetch(url, { headers: { "x-soso-api-key": KEY } });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  console.log(`\n[${res.status}] ${label}\n  ${url}`);
  console.log("  ", JSON.stringify(parsed).slice(0, 600));
  return parsed;
}

async function main() {
  await tryGet("/etfs symbol=BTC country_code=US", "/etfs", {
    symbol: "BTC",
    country_code: "US",
  });
  await tryGet("/etfs symbol=ETH country_code=US", "/etfs", {
    symbol: "ETH",
    country_code: "US",
  });
  await tryGet(
    "/etfs/summary-history symbol=BTC country_code=US",
    "/etfs/summary-history",
    { symbol: "BTC", country_code: "US" },
  );
  await tryGet(
    "/etfs/summary-history symbol=BTC country_code=US limit=5",
    "/etfs/summary-history",
    { symbol: "BTC", country_code: "US", limit: "5" },
  );
}

main().catch(console.error);
