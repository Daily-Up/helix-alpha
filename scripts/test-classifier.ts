/**
 * End-to-end test of the news classifier.
 *
 * 1. Pull a handful of recent news from SoSoValue
 * 2. Persist them in news_events (deduped)
 * 3. Run Claude classify_event on each
 * 4. Print human-readable results + token cost
 *
 * Run:
 *   npm run test:classifier
 *
 * Costs a few cents (~5 events × Sonnet 4.5).
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const { News, toMs } = await import("../src/lib/sosovalue");
  const { Assets, Events } = await import("../src/lib/db");
  const { DEFAULT_UNIVERSE, resolveUniverse } = await import(
    "../src/lib/universe"
  );
  const { classifyBatch } = await import("../src/lib/ai");

  console.log("→ Seeding asset universe (idempotent)...");
  const resolved = await resolveUniverse(DEFAULT_UNIVERSE);
  Assets.upsertAssets(resolved);
  console.log(`  ✓ ${resolved.length} assets`);

  console.log("→ Pulling latest news (last 12h, 5 items)...");
  const recent = await News.getNews({
    language: "en",
    page: 1,
    page_size: 5,
    start_time: Date.now() - 12 * 60 * 60 * 1000,
    end_time: Date.now(),
  });
  console.log(`  ✓ ${recent.list.length} items pulled`);

  console.log("→ Persisting events to DB...");
  for (const item of recent.list) {
    Events.upsertEvent(item);
    // Resolve matched_currencies to asset_ids and link as 'matched'.
    const ids: string[] = [];
    for (const c of item.matched_currencies ?? []) {
      const asset = Assets.getAssetByCurrencyId(c.currency_id);
      if (asset) ids.push(asset.id);
    }
    if (ids.length) Events.linkEventAssets(item.id, ids, "matched");
  }
  console.log(`  ✓ ${recent.list.length} events stored`);

  // Pull them back in StoredEvent shape for the classifier
  const stored = recent.list.map((i) => Events.getEventById(i.id)!).filter(Boolean);

  console.log("\n→ Classifying via Claude (this hits the API)...\n");
  const { results, errors, totals } = await classifyBatch(stored, {
    universe: resolved,
  });

  for (const r of results) {
    const e = stored.find((s) => s.id === r.event_id)!;
    const ts = new Date(toMs(e.release_time)).toISOString().slice(11, 16);
    const conf = (r.confidence * 100).toFixed(0).padStart(3);
    const sentMark =
      r.sentiment === "positive" ? "+" : r.sentiment === "negative" ? "-" : "·";
    console.log(`[${ts}] ${sentMark} ${r.event_type.padEnd(15)} sev=${r.severity.padEnd(6)} conf=${conf}%`);
    console.log(`       title: ${e.title.slice(0, 100)}`);
    console.log(
      `       affects: ${r.affected_asset_ids.join(", ") || "(none)"}`,
    );
    console.log(`       reason: ${r.reasoning}`);
    console.log("");
  }

  if (errors.length) {
    console.log(`Errors: ${errors.length}`);
    for (const e of errors) console.log(`  ${e.event_id}: ${e.error}`);
  }

  console.log("─".repeat(70));
  // Anthropic SDK semantics:
  //   input_tokens          = fresh (non-cached) input
  //   cache_read_input_tokens = pulled from cache at $0.30 / M
  //   output_tokens         = generated
  console.log(
    `Tokens — fresh-in=${totals.input}  cached-in=${totals.cached}  out=${totals.output}`,
  );
  // Sonnet 4.5 pricing: $3 input, $0.30 cache-read, $15 output per M tokens.
  const cost =
    (totals.input * 3 + totals.cached * 0.3 + totals.output * 15) / 1_000_000;
  console.log(`Approx cost: $${cost.toFixed(4)}`);
  console.log(`Total latency: ${(totals.latency_ms / 1000).toFixed(1)}s`);
  console.log("\n✅ Classifier test complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
