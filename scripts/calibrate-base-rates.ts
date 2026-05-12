/**
 * Generate data/base-rates.json from data/calibration-corpus.json.
 *
 * Usage: npx tsx scripts/calibrate-base-rates.ts
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCorpus, validateCorpus, KNOWN_SUBTYPES } from "../src/lib/calibration/corpus";
import { deriveBaseRates } from "../src/lib/calibration/derive-base-rates";

const corpus = loadCorpus();
const validation = validateCorpus(corpus, KNOWN_SUBTYPES);
if (!validation.ok) {
  console.error("[calibrate-base-rates] corpus failed validation — aborting");
  for (const e of validation.errors) {
    console.error(`  ${e.rule} (${e.event_id ?? "global"}): ${e.message}`);
  }
  process.exit(1);
}

const table = deriveBaseRates(corpus);
const out = join(process.cwd(), "data", "base-rates.json");
writeFileSync(out, JSON.stringify(table, null, 2) + "\n", "utf-8");

const cells = Object.keys(table).filter((k) => k !== "_schema");
let totalCells = 0;
for (const k of cells) {
  const v = table[k];
  if (v && typeof v === "object") {
    totalCells += Object.keys(v).length;
  }
}

console.log(`[calibrate-base-rates] wrote ${out}`);
console.log(`[calibrate-base-rates] subtypes=${cells.length} cells=${totalCells}`);
