/**
 * Diagnostic: dump RAW responses from SoSoValue crypto-stocks endpoints
 * to see what fields are available — specifically looking for earnings
 * dates, NAV-to-MC ratios, BTC holdings, premium/discount, etc.
 *
 * Run:
 *   npx tsx scripts/inspect-crypto-stocks.ts
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
      console.log(
        `\n--- next ${Math.min(opts.listSlice, t.length - 1)} items (keys only) ---`,
      );
      for (let i = 1; i < Math.min(t.length, 1 + opts.listSlice); i++) {
        const it = t[i];
        if (it && typeof it === "object" && "ticker" in it) {
          console.log(`[${i}] ticker=${(it as { ticker: string }).ticker}`);
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
  console.log("Inspecting SoSoValue crypto-stocks endpoints...\n");

  // 1) Full list
  const list = await rawGet("/crypto-stocks");
  console.log(`status: ${list.status}`);
  dump("/crypto-stocks (list)", list.body, { listSlice: 20 });

  // 2) Sectors
  const sectors = await rawGet("/crypto-stocks/sector");
  console.log(`\nstatus: ${sectors.status}`);
  dump("/crypto-stocks/sector", sectors.body);

  // Pick a representative ticker to deep-dive on
  const TICKER = "COIN";

  // 3) Market snapshot
  const snap = await rawGet(`/crypto-stocks/${TICKER}/market-snapshot`);
  console.log(`\nstatus: ${snap.status}`);
  dump(`/crypto-stocks/${TICKER}/market-snapshot`, snap.body);

  // 4) Klines (1d, last 5)
  const klines = await rawGet(`/crypto-stocks/${TICKER}/klines`, {
    interval: "1d",
    limit: "5",
  });
  console.log(`\nstatus: ${klines.status}`);
  dump(`/crypto-stocks/${TICKER}/klines`, klines.body);

  // 5) Market cap history
  const mcap = await rawGet(`/crypto-stocks/${TICKER}/market-cap`, {
    limit: "5",
  });
  console.log(`\nstatus: ${mcap.status}`);
  dump(`/crypto-stocks/${TICKER}/market-cap`, mcap.body);

  // 6) Try a few other tickers' snapshots to confirm field consistency
  for (const t of ["MSTR", "HOOD", "MARA"]) {
    const s = await rawGet(`/crypto-stocks/${t}/market-snapshot`);
    console.log(`\nstatus: ${s.status}`);
    dump(`/crypto-stocks/${t}/market-snapshot`, s.body);
  }

  // 7) Probe for any earnings-related path (these may 404, that tells us
  // the API doesn't expose earnings — we'd need a separate source)
  console.log("\n══ Earnings probes ══");
  for (const path of [
    "/crypto-stocks/COIN/earnings",
    "/crypto-stocks/earnings",
    "/crypto-stocks/COIN/financials",
    "/crypto-stocks/COIN/fundamentals",
    "/crypto-stocks/COIN/holdings",
    "/crypto-stocks/COIN/treasury",
    "/crypto-stocks/COIN/nav",
  ]) {
    const r = await rawGet(path);
    const bodyPreview =
      typeof r.body === "object" && r.body
        ? Object.keys(r.body).slice(0, 6).join(",")
        : String(r.body).slice(0, 100);
    console.log(`  ${r.status}  ${path}  → ${bodyPreview}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
