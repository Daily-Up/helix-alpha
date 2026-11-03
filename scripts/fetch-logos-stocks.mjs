// Second-pass logo fetch for the SoDEX markets still on a monogram that are real
// stocks / ETFs / commodities. Source: TradingView's public symbol logos
// (s3-symbol-logo.tradingview.com/{slug}--big.svg). Downloaded into
// /public/asset-logos (self-hosted; CSP img-src 'self' intact) and merged into
// the manifest. Synthetic / pre-market tokens (SKHX, CXMT, KORU, …) have no real
// logo anywhere and stay on the monogram.
//   node scripts/fetch-logos-stocks.mjs
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "asset-logos");
const manifestPath = join(root, "src", "components", "ui", "asset-logos.generated.ts");

// ticker -> candidate TradingView slugs (first that resolves wins).
const CANDS = {
  MCD: ["mcdonalds"],
  NKE: ["nike"],
  CRWD: ["crowdstrike", "crowdstrike-holdings"],
  MRVL: ["marvell-technology", "marvell"],
  KIOXIA: ["kioxia", "kioxia-holdings"],
  SNDK: ["sandisk", "sandisk-corp"],
  NBIS: ["nebius-group", "nebius"],
  CRWV: ["coreweave"],
  LITE: ["lumentum-holdings", "lumentum"],
  SPCX: ["spacex", "space-exploration-technologies"],
  UNITREE: ["unitree-robotics", "unitree"],
  ZHIPU: ["zhipu-ai", "zhipuai", "zhipu"],
  MINIMAX: ["minimax", "minimax-ai"],
  CXMT: ["changxin-memory-technologies", "changxin-memory"],
  NIULAI: ["niulai"],
  EWY: ["ishares-msci-south-korea-etf", "ishares-msci-south-korea-capped-etf"],
  BRENTOIL: ["brent-crude-oil", "uk-brent-oil"],
  CL: ["light-crude-oil", "crude-oil-wti", "crude-oil"],
  COPPER: ["copper", "high-grade-copper", "copper-futures"],
  NATGAS: ["natural-gas", "henry-hub-natural-gas"],
  SILVER: ["silver", "silver-futures"],
  US500: ["sp-500", "s-p-500"],
  USTECH100: ["nasdaq-100", "us-tech-100"],
};
const TV = (slug) => `https://s3-symbol-logo.tradingview.com/${slug}--big.svg`;

async function grab(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const t = await r.text();
    if (t.length < 80 || !/<svg/i.test(t)) return null;
    return t;
  } catch {
    return null;
  }
}

const got = [];
const miss = [];
for (const [tk, slugs] of Object.entries(CANDS)) {
  let saved = false;
  for (const s of slugs) {
    const svg = await grab(TV(s));
    if (svg) {
      await writeFile(join(outDir, `${tk.toLowerCase()}.svg`), svg, "utf8");
      got.push([tk, s]);
      saved = true;
      break;
    }
  }
  if (!saved) miss.push(tk);
}

// Merge into the manifest.
let m = await readFile(manifestPath, "utf8");
const add = got
  .map(([tk]) => `  ${JSON.stringify(tk.toLowerCase())}: ${JSON.stringify(tk.toLowerCase() + ".svg")},`)
  .filter((line) => !m.includes(line.trim().split(":")[0])); // skip if key already present
if (add.length) {
  m = m.replace(/\n\};\s*$/, "\n" + add.join("\n") + "\n};\n");
  await writeFile(manifestPath, m);
}

console.log("fetched (" + got.length + "):", got.map((g) => `${g[0]}←${g[1]}`).join("  "));
console.log("still missing (" + miss.length + "):", miss.join(" "));
