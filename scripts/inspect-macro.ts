/**
 * Diagnostic: dump RAW responses from /macro endpoints to verify field
 * shapes before wiring up code. Specifically interested in
 * /macro/events/{event}/history which we don't currently use.
 *
 *   npx tsx scripts/inspect-macro.ts
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
    } else {
      console.log("first:", first);
    }
    if (opts.listSlice && t.length > 1) {
      console.log(`\n--- next ${Math.min(opts.listSlice, t.length - 1)} items (compact) ---`);
      for (let i = 1; i < Math.min(t.length, 1 + opts.listSlice); i++) {
        const it = t[i];
        if (it && typeof it === "object") {
          const compact = Object.fromEntries(Object.entries(it).slice(0, 8));
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
  console.log("Inspecting /macro endpoints...\n");

  // 1) List of macro events on the calendar
  const list = await rawGet("/macro/events");
  console.log(`status: ${list.status}`);
  dump("/macro/events (list)", list.body, { listSlice: 12 });

  // Find a few unique event NAMES to test history endpoint
  // Most likely candidates: CPI, FOMC, NFP, GDP, PPI
  const candidates = ["CPI", "FOMC", "NFP", "GDP", "PPI", "Unemployment Rate"];
  for (const evt of candidates) {
    const r = await rawGet(
      `/macro/events/${encodeURIComponent(evt)}/history`,
    );
    console.log(`\nstatus: ${r.status}`);
    dump(`/macro/events/${evt}/history`, r.body, { listSlice: 5 });
  }

  // Try with paging
  const paged = await rawGet("/macro/events/CPI/history", {
    page: 1,
    page_size: 50,
  });
  console.log(`\nstatus: ${paged.status}`);
  dump("/macro/events/CPI/history?page=1&page_size=50", paged.body, {
    listSlice: 3,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
