/**
 * Verify the live shape of /indices/{ticker}/market-snapshot.
 *
 *   npm run inspect:indices
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

const BASE = process.env.SOSOVALUE_BASE_URL!;
const KEY = process.env.SOSOVALUE_API_KEY!;

async function rawGet(path: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "x-soso-api-key": KEY },
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  for (const t of ["ssimag7", "ssidefi", "ssirwa"]) {
    const snap = await rawGet(`/indices/${t}/market-snapshot`);
    console.log(`\n══ /indices/${t}/market-snapshot (${snap.status}) ══`);
    console.log(JSON.stringify(snap.body, null, 2));
    if (snap.body && typeof snap.body === "object" && "data" in snap.body) {
      const data = (snap.body as { data: unknown }).data;
      if (data && typeof data === "object") {
        console.log("keys:", Object.keys(data as object));
      }
    }
  }

  // Also look at index klines shape
  const kl = await rawGet(`/indices/ssimag7/klines?interval=1d&limit=3`);
  console.log(`\n══ /indices/ssimag7/klines (${kl.status}) ══`);
  console.log(JSON.stringify(kl.body, null, 2));

  // Also constituents
  const con = await rawGet(`/indices/ssimag7/constituents`);
  console.log(`\n══ /indices/ssimag7/constituents (${con.status}) ══`);
  console.log(JSON.stringify(con.body, null, 2)?.slice(0, 600));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
