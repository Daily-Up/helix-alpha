/**
 * Diagnostic: inspect /analyses + /analyses/{chart_name} to see what
 * SoSoValue's "Analysis Charts" surface actually contains.
 *
 *   npx tsx scripts/inspect-analyses.ts
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

const BASE = process.env.SOSOVALUE_BASE_URL!;
const KEY = process.env.SOSOVALUE_API_KEY!;

async function rawGet(path: string) {
  const url = BASE + path;
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

function unwrap(b: unknown): unknown {
  let t = b;
  if (t && typeof t === "object" && "data" in (t as Record<string, unknown>)) {
    t = (t as { data: unknown }).data;
  }
  return t;
}

(async () => {
  // 1) List every chart available
  console.log("══ /analyses (chart list) ══");
  const list = await rawGet("/analyses");
  console.log("status:", list.status);
  const items = unwrap(list.body);
  if (Array.isArray(items)) {
    console.log("array length:", items.length);
    if (items.length > 0) {
      console.log("first item keys:", Object.keys(items[0] as object));
      console.log("first item:", JSON.stringify(items[0], null, 2));
    }
    console.log("\n--- All chart entries (compact) ---");
    for (const it of items) {
      if (it && typeof it === "object") {
        const compact = Object.fromEntries(
          Object.entries(it).slice(0, 6),
        );
        console.log(JSON.stringify(compact));
      }
    }
  } else {
    console.log("body:", JSON.stringify(list.body).slice(0, 500));
  }

  // 2) For 2-3 candidate charts, fetch their data shape
  const candidates: string[] = [];
  if (Array.isArray(items)) {
    for (const it of items.slice(0, 3)) {
      if (it && typeof it === "object") {
        const obj = it as Record<string, unknown>;
        // Try common name fields
        const name =
          (obj.chart_name as string) ??
          (obj.name as string) ??
          (obj.id as string) ??
          (obj.key as string);
        if (name) candidates.push(name);
      }
    }
  }
  // Always probe a few common known names
  for (const probe of [
    "btc_dominance",
    "BTC Dominance",
    "stablecoin_supply",
    "fear_greed_index",
  ]) {
    if (!candidates.includes(probe)) candidates.push(probe);
  }

  console.log("\n──────────");
  for (const name of candidates) {
    const r = await rawGet(`/analyses/${encodeURIComponent(name)}`);
    console.log(`\n══ /analyses/${name} ══`);
    console.log("status:", r.status);
    const body = unwrap(r.body);
    if (Array.isArray(body)) {
      console.log("array length:", body.length);
      if (body.length > 0) {
        console.log("first 2:", JSON.stringify(body.slice(0, 2), null, 2));
      }
    } else if (body && typeof body === "object") {
      console.log("keys:", Object.keys(body));
      console.log("body:", JSON.stringify(body, null, 2).slice(0, 1500));
    } else {
      console.log("raw:", body);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
