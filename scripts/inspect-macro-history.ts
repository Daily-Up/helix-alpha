import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

const BASE = process.env.SOSOVALUE_BASE_URL!;
const KEY = process.env.SOSOVALUE_API_KEY!;

async function rawGet(path: string) {
  const url = BASE + path;
  const res = await fetch(url, {
    headers: { "x-soso-api-key": KEY },
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

(async () => {
  for (const name of [
    "CPI (MoM)",
    "CPI (YoY)",
    "Core CPI (MoM)",
    "PPI (MoM)",
    "Retail Sales (MoM)",
    "Existing Home Sales",
    "S&P Global US Manufacturing PMI",
  ]) {
    const enc = encodeURIComponent(name);
    const r = await rawGet(`/macro/events/${enc}/history`);
    let list: unknown = r.body;
    if (
      list &&
      typeof list === "object" &&
      "data" in (list as Record<string, unknown>)
    ) {
      list = (list as { data: unknown }).data;
    }
    const len = Array.isArray(list) ? list.length : "(not array)";
    console.log(`${name} → status ${r.status} | length ${len}`);
    if (Array.isArray(list) && list.length > 0) {
      console.log("  keys:", Object.keys(list[0] as object));
      console.log("  first:", JSON.stringify(list[0]));
      console.log("  most recent 3:");
      for (const it of list.slice(0, 3))
        console.log("    ", JSON.stringify(it));
    } else if (!Array.isArray(list)) {
      console.log("  body:", JSON.stringify(list).slice(0, 300));
    }
  }
})();
