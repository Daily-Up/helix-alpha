// Regenerates src/components/ui/asset-logos.generated.ts from whatever logo
// files currently live in public/asset-logos/. Run after adding/removing logos:
//   node scripts/gen-asset-logos.mjs
//
// Logos are sourced (and bundled locally, served same-origin) from:
//   crypto  → assets.coincap.io/assets/icons/<sym>@2x.png  +  cryptocurrency-icons (CC0 svg)
//   equity/ETF → financialmodelingprep.com/image-stock/<TICKER>.png (twelvedata fallback)
// The key is the cleaned lowercase asset symbol; the value is the on-disk filename.
import { readdirSync, writeFileSync } from "node:fs";

const dir = "public/asset-logos";
const files = readdirSync(dir).filter((f) => /\.(svg|png|jpg|jpeg|webp)$/i.test(f));
const map = {};
for (const f of files) map[f.replace(/\.(svg|png|jpg|jpeg|webp)$/i, "").toLowerCase()] = f;

const keys = Object.keys(map).sort();
const isIdent = (k) => /^[a-z_$][a-z0-9_$]*$/i.test(k);
const body = keys
  .map((k) => `  ${isIdent(k) ? k : JSON.stringify(k)}: ${JSON.stringify(map[k])},`)
  .join("\n");

writeFileSync(
  "src/components/ui/asset-logos.generated.ts",
  `// AUTO-GENERATED — do not edit by hand. Maps cleaned lowercase asset key → bundled logo file.\nexport const ASSET_LOGO_FILES: Record<string, string> = {\n${body}\n};\n`,
);
console.log(`asset-logos manifest: ${keys.length} entries`);
