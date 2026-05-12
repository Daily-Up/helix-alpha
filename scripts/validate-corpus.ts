/**
 * Validate data/calibration-corpus.json against Phase A integrity rules.
 *
 * Usage: npx tsx scripts/validate-corpus.ts
 *
 * Exit code 0 on success (errors == 0). Warnings do not fail the script.
 */

import {
  loadCorpus,
  validateCorpus,
  KNOWN_SUBTYPES,
} from "../src/lib/calibration/corpus";

const corpus = loadCorpus();
const result = validateCorpus(corpus, KNOWN_SUBTYPES);

console.log(`[validate-corpus] schema_version=${corpus.schema_version}`);
console.log(`[validate-corpus] generated_at=${corpus.generated_at}`);
console.log(`[validate-corpus] total_events=${result.total_events}`);
console.log(`[validate-corpus] errors=${result.errors.length}`);
console.log(`[validate-corpus] warnings=${result.warnings.length}`);

if (result.errors.length > 0) {
  console.error("\n[validate-corpus] ERRORS:");
  for (const e of result.errors) {
    console.error(`  ${e.rule} (${e.event_id ?? "global"}): ${e.message}`);
  }
}

if (result.warnings.length > 0) {
  console.warn("\n[validate-corpus] WARNINGS:");
  for (const w of result.warnings) {
    console.warn(`  ${w.rule} (${w.event_id ?? "global"}): ${w.message}`);
  }
}

console.log("\n[validate-corpus] subtype distribution:");
for (const [k, v] of Object.entries(result.subtype_counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${v.toString().padStart(4)}  ${k}`);
}

console.log("\n[validate-corpus] asset_class distribution:");
for (const [k, v] of Object.entries(result.asset_class_counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${v.toString().padStart(4)}  ${k}`);
}

console.log("\n[validate-corpus] confidence distribution:");
for (const [k, v] of Object.entries(result.confidence_counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${v.toString().padStart(4)}  ${k}`);
}

if (!result.ok) {
  console.error("\n[validate-corpus] FAILED");
  process.exit(1);
}
console.log("\n[validate-corpus] OK");
