/**
 * Diagnostic: dump RAW responses from /btc-treasuries endpoints to
 * verify field names before wiring up wrappers/types.
 *
 *   npx tsx scripts/inspect-btc-treasuries.ts
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

const BASE = process.env.SOSOVALUE_BASE_URL!;
const KEY = process.env.SOSOVALUE_API_KEY!;

async function rawGet(
  path: string,
  query: Record<string, string | number> = {},
) {
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
  return { status: res.status, body: parsed };
}

function unwrap(body: unknown): unknown {
  let t = body;
  if (t && typeof t === "object" && "data" in t) {
    t = (t as { data: unknown }).data;
  }
  return t;
}

function dump(label: string, body: unknown, opts: { listSlice?: number } = {}) {
  console.log(`\n══ ${label} ══`);
  const t = unwrap(body);
  if (Array.isArray(t)) {
    console.log(`array length: ${t.length}`);
    const first = t[0];
    if (first && typeof first === "object") {
      console.log("first item keys:", Object.keys(first));
      console.log("first item:", JSON.stringify(first, null, 2));
    }
    if (opts.listSlice && t.length > 1) {
      console.log(`\n--- next ${Math.min(opts.listSlice, t.length - 1)} items (compact) ---`);
      for (let i = 1; i < Math.min(t.length, 1 + opts.listSlice); i++) {
        const it = t[i];
        if (it && typeof it === "object") {
          const compact = Object.fromEntries(
            Object.entries(it).slice(0, 6),
          );
          console.log(`[${i}]`, JSON.stringify(compact));
        }
      }
    }
  } else if (t && typeof t === "object") {
    console.log("keys:", Object.keys(t));
    console.log("body:", JSON.stringify(t, null, 2));
  } else {
    console.log("raw:", t);
  }
}

async function main() {
  console.log("Inspecting /btc-treasuries endpoints...\n");

  // 1) List of treasury companies
  const list = await rawGet("/btc-treasuries");
  console.log(`status: ${list.status}`);
  dump("/btc-treasuries (list)", list.body, { listSlice: 8 });

  // Try a few common pagination probes if the response was paginated
  const list2 = await rawGet("/btc-treasuries", { page: 1, page_size: 50 });
  console.log(`\nstatus: ${list2.status}`);
  dump("/btc-treasuries?page=1&page_size=50", list2.body, { listSlice: 8 });

  // 2) Purchase history for MSTR (canonical example)
  const ticker = "MSTR";
  const hist = await rawGet(`/btc-treasuries/${ticker}/purchase-history`);
  console.log(`\nstatus: ${hist.status}`);
  dump(`/btc-treasuries/${ticker}/purchase-history`, hist.body, {
    listSlice: 5,
  });

  const hist2 = await rawGet(`/btc-treasuries/${ticker}/purchase-history`, {
    page: 1,
    page_size: 50,
  });
  console.log(`\nstatus: ${hist2.status}`);
  dump(
    `/btc-treasuries/${ticker}/purchase-history?page=1&page_size=50`,
    hist2.body,
    { listSlice: 5 },
  );

  // 3) Try a couple more tickers
  for (const t of ["MARA", "RIOT"]) {
    const r = await rawGet(`/btc-treasuries/${t}/purchase-history`, {
      page: 1,
      page_size: 5,
    });
    console.log(`\nstatus: ${r.status}`);
    dump(`/btc-treasuries/${t}/purchase-history (first 5)`, r.body);
  }

  // 4) Re-test the previously-404 /crypto-stocks/sector endpoint —
  // docs say it should exist.
  const stockSec = await rawGet("/crypto-stocks/sector");
  console.log(`\nstatus: ${stockSec.status}`);
  dump("/crypto-stocks/sector (re-test)", stockSec.body);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
