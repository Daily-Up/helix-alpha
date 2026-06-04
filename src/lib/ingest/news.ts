/**
 * News ingest pipeline.
 *
 *   1. Pull recent news from SoSoValue
 *   2. Persist each event (idempotent on SoSoValue news id)
 *   3. Resolve matched_currencies → asset_ids (link as 'matched')
 *   4. Classify each NEW event with Claude (link affected_asset_ids as 'inferred')
 *
 * Returns a structured summary suitable for both the cron audit log and
 * the activity feed in the dashboard. Designed to be safe to call again
 * 5 minutes later — re-runs only classify events that aren't classified yet.
 */

import { Assets, Cron, Events, Classifications } from "@/lib/db";
import { classifyBatch } from "@/lib/ai";
import {
  classifyBatchWithAgent,
  agentClassifierCap,
  agentClassifierEnabled,
} from "@/lib/ai/agents/classify-batch";
import { News } from "@/lib/sosovalue";
import {
  DEFAULT_UNIVERSE,
  resolveUniverse,
  type Asset,
} from "@/lib/universe";
import {
  sanitizeText,
  validateTitle,
} from "@/lib/pipeline/ingestion-validation";
import { fetchTweets, isTrustedXAccount } from "./x-tweet-feed";
import { embed } from "@/lib/pipeline/embeddings";
import { classifyFreshness } from "@/lib/pipeline/freshness";
import { corpusFilter } from "@/lib/calibration/corpus-filter";
import { insertSkipped } from "@/lib/db/repos/skipped-pre-classify";
import type { StoredEvent } from "@/lib/db/repos/events";

/** Pull symbols out of the StoredEvent.matched_currencies array. */
function parseMatchedCurrencySymbols(
  matched: StoredEvent["matched_currencies"],
): string[] {
  if (!Array.isArray(matched)) return [];
  return matched
    .map((c) => c?.symbol)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
}

export interface NewsIngestSummary {
  /** How many news items came back from SoSoValue. */
  fetched: number;
  /** How many we'd never seen before (newly inserted). */
  new_events: number;
  /** Items rejected at the ingestion gate for malformed titles
   *  (HTML, parser-prefix leak, mid-sentence truncation, doubled
   *  source name, >250 chars, empty after sanitize). Bug class 7. */
  rejected_malformed: number;
  /** Newly-ingested events that were detected as duplicates of an
   *  existing story and short-circuited before classification. Each
   *  one represents a Claude classification we DIDN'T have to pay for. */
  duplicates_skipped: number;
  /** Events that ran through Claude in this run. */
  classified: number;
  /** Events dropped by the corpus pre-classify gate (Phase G / I-46) —
   *  didn't structurally resemble any historical signal. Each one
   *  represents a Claude classification we DIDN'T have to pay for. */
  skipped_pre_classify: number;
  /** Classification failures. */
  classification_errors: number;
  /** How many events the research agent handled this cycle (Wave 2). */
  agent_classified: number;
  /** Token totals for Claude. */
  tokens: { input: number; output: number; cached: number };
  /** Approx Claude cost in USD. */
  cost_usd: number;
  /** Latency end-to-end in ms. */
  latency_ms: number;
}

export interface NewsIngestOptions {
  /** Window of news to pull. Capped at 7 days by the API. */
  windowMs?: number;
  /** Cap on items pulled per run (defaults to 200). */
  maxItems?: number;
  /** If true, re-classify even already-classified events. */
  reclassify?: boolean;
  /** Override the default universe (e.g. for tests). */
  universe?: Asset[];
  /** Skip Claude entirely; just pull + persist. Useful in CI. */
  skipClassify?: boolean;
}

/** Anthropic pricing per M tokens. Classifier path uses Haiku 4.5 by
 *  default ($1 in / $0.10 cached / $5 out) — see ANTHROPIC_CLASSIFIER_MODEL.
 *  If you flip the classifier back to Sonnet, swap to 3 / 0.3 / 15. */
const PRICING = { input: 1, cached: 0.1, output: 5 };

export async function runNewsIngest(
  opts: NewsIngestOptions = {},
): Promise<NewsIngestSummary> {
  const t0 = Date.now();
  const windowMs = opts.windowMs ?? 60 * 60 * 1000; // 1 hour by default
  const maxItems = opts.maxItems ?? 200;

  // Universe: assume already-seeded; fall back to in-memory if not.
  let universe = opts.universe;
  if (!universe) {
    const stored = await Assets.getAllAssets();
    universe = stored.length > 0 ? stored : await resolveUniverse(DEFAULT_UNIVERSE);
  }

  // ── 1. Fetch news ──────────────────────────────────────────────
  // Standard editorial feed (categories 1, 2, 3, 13 — Odaily,
  // Cointelegraph, The Block, etc.) plus the full X feed (categories
  // 4 + 7 — KOL + project / newsroom tweets). Tweets land 15-90
  // minutes ahead of editorial coverage on breaking stories; for
  // some events (Wu Blockchain scoops, on-chain exploit alerts) X
  // is the only source for the first hour or two.
  //
  // We don't keyword-filter the X feed; the corpus pre-filter and
  // classifier do the quality work downstream. Posts from a curated
  // set of trusted accounts (Wu Blockchain, CoinDesk, Halborn, etc.)
  // are tagged so the corpus pre-filter can let them through and the
  // source-tier scorer can rate them as tier-1.
  const dayWindow = Math.max(1, Math.ceil(windowMs / (24 * 60 * 60 * 1000)));
  const [editorial, tweets] = await Promise.all([
    News.fetchRecentNews({
      daysBack: dayWindow,
      maxItems,
      language: "en",
    }),
    fetchTweets({
      daysBack: dayWindow,
      maxItems: 300,
    }).catch((e) => {
      console.warn(`[news-ingest] tweet fetch failed: ${(e as Error).message}`);
      return [] as Awaited<ReturnType<typeof fetchTweets>>;
    }),
  ]);

  // De-dup by id (an item could appear in both feeds if SoSoValue
  // ever reuses ids across categories).
  const mergedById = new Map<string, (typeof editorial)[number]>();
  for (const x of [...editorial, ...tweets]) mergedById.set(x.id, x);
  const items = [...mergedById.values()];

  // Filter to the actual window (fetchRecentNews uses day-resolution).
  const cutoff = Date.now() - windowMs;
  const fresh = items.filter((i) => Number(i.release_time) >= cutoff);

  // ── 2 & 3. Persist + link matched_currencies + content-level dedup ─
  // For each newly-inserted event we run a similarity search against
  // events from the last 48h. If we find a near-twin (same story from
  // a different outlet) we mark it as a duplicate so the classifier
  // skips it. id-level dedup alone misses these because each outlet
  // gets its own SoSoValue news_id.
  let newEvents = 0;
  let duplicatesSkipped = 0;
  let rejectedMalformed = 0;
  // D1 side channels: we compute embeddings during the dedup pass and
  // pass them to the classifier so it can persist them onto the
  // classification row in a single round-trip.
  const precomputedEmbeddings = new Map<string, number[]>();
  const coverageContinuations = new Map<string, string>();
  for (const item of fresh) {
    // ── Stage 1: Ingestion validation gate ──
    // AUTHORITATIVE: src/lib/pipeline/ingestion-validation.ts.
    // Tested in tests/ingestion-validation.test.ts + adversarial-fixtures (F11).
    // Sanitize first (strips HTML), then validate the cleaned title.
    // Bug 7 example caught: "original text: ..." parser-prefix leaks.
    const cleanedTitle = sanitizeText(item.title);
    const validation = validateTitle(cleanedTitle || item.title || "");
    if (!validation.ok) {
      rejectedMalformed++;
      console.warn(
        `[news-ingest] rejected ${item.id}: ${validation.reason}${
          validation.detail ? `(${validation.detail})` : ""
        } — "${(item.title ?? "").slice(0, 80)}"`,
      );
      continue;
    }

    const { inserted } = await Events.upsertEvent(item);
    if (inserted) newEvents++;

    const matchedIds: string[] = [];
    for (const c of item.matched_currencies ?? []) {
      const a = await Assets.getAssetByCurrencyId(c.currency_id);
      if (a) matchedIds.push(a.id);
    }
    if (matchedIds.length > 0) {
      await Events.linkEventAssets(item.id, matchedIds, "matched");
    }

    if (inserted) {
      // Stage 1: existing exact-match dedup (Events.findDuplicateEvent).
      const dup = await Events.findDuplicateEvent({
        id: item.id,
        title: item.title ?? "",
        release_time: Number(item.release_time),
        matched_currencies: item.matched_currencies ?? null,
      });
      if (dup) {
        await Events.markAsDuplicate(item.id, dup.canonical_id);
        duplicatesSkipped++;
        continue;
      }

      // ── Dimension 1: semantic freshness gate ──
      // AUTHORITATIVE: src/lib/pipeline/freshness.ts.
      // Two outlets covering the same Coinbase outage hash differently
      // (the exact-match dedup above only catches title/Jaccard hits)
      // but their embeddings are close. We compute the new article's
      // embedding, compare against recent classifications, and either:
      //   • duplicate → mark as duplicate_of, skip classification ($)
      //   • continuation → classify normally, link to prior event
      //   • novel → proceed normally
      const cleanedTitle = sanitizeText(item.title);
      const cleanedBody = sanitizeText(item.content);
      const haystack = [cleanedTitle, cleanedBody.slice(0, 400)]
        .filter(Boolean)
        .join(". ");
      const newEmbedding = embed(haystack);
      const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const recent = await Classifications.listRecentEmbeddings(sinceMs);
      const verdict = classifyFreshness({
        new_embedding: newEmbedding,
        history: recent,
      });
      if (
        verdict.verdict === "duplicate" &&
        verdict.matched_event_id != null
      ) {
        await Events.markAsDuplicate(item.id, verdict.matched_event_id);
        duplicatesSkipped++;
        // Don't continue — we still want to persist the embedding for
        // future similarity comparisons (against this duplicate's
        // counterparts). But skip classification.
        continue;
      }
      // Stash the embedding so a later classifier upsert can include
      // it without recomputing. We attach it to the item as a non-DB
      // field via a side-channel map (item is read-only from API).
      precomputedEmbeddings.set(item.id, newEmbedding);
      if (verdict.verdict === "continuation" && verdict.matched_event_id) {
        coverageContinuations.set(item.id, verdict.matched_event_id);
      }
    }
  }

  // ── 4. Classify ────────────────────────────────────────────────
  let classified = 0;
  let classificationErrors = 0;
  let summaryAgentClassified = 0;
  const tokens = { input: 0, output: 0, cached: 0 };

  // ── KILL SWITCH ──
  // CLASSIFICATION_PAUSED=1 short-circuits the Claude call entirely.
  // Ingest still pulls and persists news_events rows, but no
  // classifications are produced.
  const paused =
    process.env.CLASSIFICATION_PAUSED === "1" ||
    process.env.CLASSIFICATION_PAUSED === "true";

  let skippedPreClassify = 0;

  if (!opts.skipClassify && !paused) {
    // Batch size 150 — large enough to drain backlog under bursty
    // ingest while still fitting in Vercel's 60s maxDuration.
    let rawTargets: StoredEvent[];
    if (opts.reclassify) {
      const events = await Promise.all(
        fresh.map((i) => Events.getEventById(i.id)),
      );
      rawTargets = events.filter((e): e is StoredEvent => !!e);
    } else {
      rawTargets = await Events.getUnclassifiedEvents(150);
    }

    // ── Corpus pre-classify gate (Phase G, invariant I-46) ──
    // AUTHORITATIVE: src/lib/calibration/corpus-filter.ts.
    // Score each headline against the 95-event calibration corpus by
    // max cosine similarity + asset_class match. Headlines that don't
    // structurally resemble any historical signal are dropped here —
    // they land in skipped_pre_classify and never burn Claude tokens.
    // The reclassify path bypasses the gate (operator intent overrides).
    const targets: StoredEvent[] = [];
    for (const e of rawTargets) {
      if (opts.reclassify) {
        targets.push(e);
        continue;
      }
      // Trusted X accounts (Wu Blockchain, Halborn, CoinDesk, etc.)
      // bypass the corpus filter — they break stories ahead of the
      // editorial corpus by definition, so requiring structural
      // similarity to past signals would systematically drop the
      // freshest, highest-signal inputs.
      if (isTrustedXAccount(e.author)) {
        targets.push(e);
        continue;
      }
      const matchedSymbols = parseMatchedCurrencySymbols(e.matched_currencies);
      const verdict = corpusFilter({
        title: e.title,
        content: e.content,
        matched_currency_symbols: matchedSymbols,
      });
      if (verdict.verdict === "drop") {
        try {
          await insertSkipped({
            id: e.id,
            headline_text: e.title,
            corpus_score: verdict.score,
            max_cosine: verdict.max_cosine,
            top_match_event_id: verdict.top_match_id,
            asset_classes_detected: verdict.asset_classes_detected,
            asset_class_in_corpus: verdict.asset_class_in_corpus,
            reasoning: verdict.reasoning,
          });
        } catch (err) {
          // Never let a forensic log failure stop the gate.
          console.warn(
            `[news-ingest] skipped_pre_classify insert failed for ${e.id}: ${(err as Error).message}`,
          );
        }
        skippedPreClassify++;
        continue;
      }
      targets.push(e);
    }

    let agentClassified = 0;
    let agentRemaining = targets;

    if (targets.length > 0 && agentClassifierEnabled()) {
      // Run the research agent on the most-recent N events. Anything
      // above the cap falls through to the Wave 1 batch classifier so a
      // burst of incoming news doesn't blow the budget.
      const cap = agentClassifierCap();
      const sliceForAgent = targets.slice(0, cap);
      agentRemaining = targets.slice(cap);
      try {
        const agentRes = await classifyBatchWithAgent(sliceForAgent, {
          universe,
        });
        agentClassified = agentRes.results.length;
        classified += agentRes.results.length;
        classificationErrors += agentRes.errors.length;
        tokens.input += agentRes.totals.input;
        tokens.output += agentRes.totals.output;
        tokens.cached += agentRes.totals.cached;
      } catch (err) {
        console.warn(
          `[news-ingest] agent classifier failed; falling back: ${(err as Error).message}`,
        );
        // Fall back: re-queue everything to the Wave 1 batch path.
        agentRemaining = targets;
      }
    }

    if (agentRemaining.length > 0) {
      const { results, errors, totals } = await classifyBatch(agentRemaining, {
        universe,
        embeddings: precomputedEmbeddings,
        coverageContinuations,
      });
      classified += results.length;
      classificationErrors += errors.length;
      tokens.input += totals.input;
      tokens.output += totals.output;
      tokens.cached += totals.cached;
    }
    // Stash on summary via the outer-scope variable.
    summaryAgentClassified = agentClassified;
  }

  const cost_usd =
    (tokens.input * PRICING.input +
      tokens.cached * PRICING.cached +
      tokens.output * PRICING.output) /
    1_000_000;

  return {
    fetched: fresh.length,
    new_events: newEvents,
    rejected_malformed: rejectedMalformed,
    duplicates_skipped: duplicatesSkipped,
    classified,
    skipped_pre_classify: skippedPreClassify,
    classification_errors: classificationErrors,
    agent_classified: summaryAgentClassified,
    tokens,
    cost_usd,
    latency_ms: Date.now() - t0,
  };
}

/**
 * Convenience wrapper that records the run in `cron_runs`.
 * Used by the API route + CLI test.
 */
export async function runNewsIngestWithAudit(
  opts: NewsIngestOptions = {},
): Promise<NewsIngestSummary & { run_id: number }> {
  const { id, data } = await Cron.recordRun("ingest_news", async () => {
    const summary = await runNewsIngest(opts);
    const text =
      `fetched=${summary.fetched} new=${summary.new_events} ` +
      `rejected=${summary.rejected_malformed} ` +
      `dups=${summary.duplicates_skipped} ` +
      `pre_skipped=${summary.skipped_pre_classify} ` +
      `classified=${summary.classified} errs=${summary.classification_errors} ` +
      `cost=$${summary.cost_usd.toFixed(4)}`;
    return { summary: text, data: summary };
  });
  return { ...(data as NewsIngestSummary), run_id: id };
}
