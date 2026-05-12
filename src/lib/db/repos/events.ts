/**
 * Repository — `news_events`, `event_assets`, `classifications`.
 *
 * The ingest worker uses `upsertEvent` to write items idempotently; the
 * dashboard uses `listRecentEvents` to render the activity feed.
 */

import { db } from "../client";
import { toMs, type NewsItem } from "@/lib/sosovalue";

export interface StoredEvent {
  id: string;
  release_time: number;
  title: string;
  content: string | null;
  author: string | null;
  source_link: string | null;
  original_link: string | null;
  category: number;
  tags: string[];
  matched_currencies: Array<{ currency_id: string; symbol: string; name: string }>;
  impression_count: number | null;
  like_count: number | null;
  retweet_count: number | null;
  is_blue_verified: boolean;
  ingested_at: number;
}

interface EventRow {
  id: string;
  release_time: number;
  title: string;
  content: string | null;
  author: string | null;
  source_link: string | null;
  original_link: string | null;
  category: number;
  tags: string | null;
  matched_currencies: string | null;
  impression_count: number | null;
  like_count: number | null;
  retweet_count: number | null;
  is_blue_verified: number;
  ingested_at: number;
}

/**
 * Sanitize text from the API: strip HTML tags + decode entities + normalize ws.
 *
 * AUTHORITATIVE: src/lib/pipeline/ingestion-validation.ts (`sanitizeText`).
 * This module re-exports under the same name so existing call sites stay
 * untouched while the pipeline version becomes the single source of truth.
 * Tested in tests/ingestion-validation.test.ts.
 */
import { sanitizeText as pipelineSanitize } from "@/lib/pipeline/ingestion-validation";
function sanitizeText(s: string | null | undefined): string {
  return pipelineSanitize(s);
}

/** Derive a non-null title from the API payload. Always sanitized. */
function deriveTitle(
  title: string | null | undefined,
  content: string | null | undefined,
): string {
  const cleanTitle = sanitizeText(title);
  if (cleanTitle) return cleanTitle;
  const cleanContent = sanitizeText(content);
  if (cleanContent) return cleanContent.slice(0, 200);
  return "(untitled)";
}

function rowToEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    release_time: row.release_time,
    title: row.title,
    content: row.content,
    author: row.author,
    source_link: row.source_link,
    original_link: row.original_link,
    category: row.category,
    tags: row.tags ? JSON.parse(row.tags) : [],
    matched_currencies: row.matched_currencies
      ? JSON.parse(row.matched_currencies)
      : [],
    impression_count: row.impression_count,
    like_count: row.like_count,
    retweet_count: row.retweet_count,
    is_blue_verified: !!row.is_blue_verified,
    ingested_at: row.ingested_at,
  };
}

/**
 * Insert (or replace) one news event from a raw SoSoValue payload.
 *
 * Returns whether it was newly inserted (true) or already present (false).
 * `event_assets` is also populated from `matched_currencies` — we resolve
 * those currency_ids to internal asset_ids in `linkEventAssets`.
 */
export function upsertEvent(item: NewsItem): { inserted: boolean } {
  const exists = db()
    .prepare<[string], { id: string }>(
      "SELECT id FROM news_events WHERE id = ?",
    )
    .get(item.id);

  db()
    .prepare(
      `INSERT INTO news_events (
         id, release_time, title, content, author, source_link, original_link,
         category, tags, matched_currencies,
         impression_count, like_count, retweet_count, is_blue_verified,
         raw_json
       ) VALUES (
         @id, @release_time, @title, @content, @author, @source_link, @original_link,
         @category, @tags, @matched_currencies,
         @impression_count, @like_count, @retweet_count, @is_blue_verified,
         @raw_json
       )
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         content = excluded.content,
         tags = excluded.tags,
         matched_currencies = excluded.matched_currencies`,
    )
    .run({
      id: item.id,
      release_time: toMs(item.release_time),
      // SoSoValue occasionally returns items with no title (media-only quotes).
      // Keep the row anyway so body / matched_currencies stay queryable.
      title: deriveTitle(item.title, item.content),
      content: sanitizeText(item.content) || null,
      author: item.author ?? null,
      source_link: item.source_link ?? null,
      original_link: item.original_link ?? null,
      category: item.category,
      tags: JSON.stringify(item.tags ?? []),
      matched_currencies: JSON.stringify(item.matched_currencies ?? []),
      impression_count: item.impression_count ?? null,
      like_count: item.like_count ?? null,
      retweet_count: item.retweet_count ?? null,
      is_blue_verified: item.is_blue_verified ? 1 : 0,
      raw_json: JSON.stringify(item),
    });

  return { inserted: !exists };
}

/**
 * Link an event to its asset_ids (in event_assets).
 * `source` distinguishes "matched" (from SoSoValue) vs "inferred" (Claude).
 */
export function linkEventAssets(
  eventId: string,
  assetIds: string[],
  source: "matched" | "inferred",
): void {
  if (assetIds.length === 0) return;
  const stmt = db().prepare(
    `INSERT OR IGNORE INTO event_assets (event_id, asset_id, source)
     VALUES (?, ?, ?)`,
  );
  const tx = db().transaction((ids: string[]) => {
    for (const id of ids) stmt.run(eventId, id, source);
  });
  tx(assetIds);
}

// ─────────────────────────────────────────────────────────────────────────
// Read paths
// ─────────────────────────────────────────────────────────────────────────

export function getEventById(id: string): StoredEvent | undefined {
  const row = db()
    .prepare<[string], EventRow>("SELECT * FROM news_events WHERE id = ?")
    .get(id);
  return row ? rowToEvent(row) : undefined;
}

export function listRecentEvents(opts?: {
  limit?: number;
  category?: number;
  assetId?: string;
}): StoredEvent[] {
  const limit = opts?.limit ?? 100;
  let sql = "SELECT n.* FROM news_events n";
  const params: Array<string | number> = [];

  if (opts?.assetId) {
    sql += " JOIN event_assets ea ON ea.event_id = n.id";
    sql += " WHERE ea.asset_id = ?";
    params.push(opts.assetId);
    if (opts.category !== undefined) {
      sql += " AND n.category = ?";
      params.push(opts.category);
    }
  } else if (opts?.category !== undefined) {
    sql += " WHERE n.category = ?";
    params.push(opts.category);
  }
  sql += " ORDER BY n.release_time DESC LIMIT ?";
  params.push(limit);

  const rows = db().prepare<typeof params, EventRow>(sql).all(...params);
  return rows.map(rowToEvent);
}

/** How many events have NOT been classified yet. Excludes events flagged
 *  as duplicates of an earlier story — those don't need classification. */
export function countUnclassifiedEvents(): number {
  const row = db()
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM news_events n
       LEFT JOIN classifications c ON c.event_id = n.id
       LEFT JOIN skipped_pre_classify s ON s.id = n.id
       WHERE c.event_id IS NULL
         AND s.id IS NULL
         AND n.duplicate_of IS NULL`,
    )
    .get();
  return row?.n ?? 0;
}

/** Iterate (in batches) the unclassified events for the classifier.
 *
 *  Excludes:
 *    - events that already have a classification (obvious)
 *    - duplicates of canonical events (handled separately)
 *    - events recorded in `skipped_pre_classify` — they've already been
 *      gated out by the corpus filter or marked as backlog-skipped.
 *      Without this join the gate would re-evaluate every dropped event
 *      on every cron tick, which is wasted CPU even though it costs no
 *      Claude tokens. */
export function getUnclassifiedEvents(limit = 50): StoredEvent[] {
  const rows = db()
    .prepare<[number], EventRow>(
      `SELECT n.* FROM news_events n
       LEFT JOIN classifications c ON c.event_id = n.id
       LEFT JOIN skipped_pre_classify s ON s.id = n.id
       WHERE c.event_id IS NULL
         AND s.id IS NULL
         AND n.duplicate_of IS NULL
       ORDER BY n.release_time DESC
       LIMIT ?`,
    )
    .all(limit);
  return rows.map(rowToEvent);
}

// ─────────────────────────────────────────────────────────────────────────
// Content-level deduplication
//
// SoSoValue's news feed often carries 3-6 outlets reporting the SAME
// underlying story (e.g. PANews, ChainCatcher, Decrpt, ForesightNews
// each post about a Coinbase × AWS partnership within minutes). They
// all get unique news ids, so id-level dedup doesn't catch them; without
// content-level dedup we'd burn Claude tokens classifying the same
// story 4 times.
//
// The detector below runs a token-set Jaccard with currency-overlap
// rules:
//   • Both events tag matched currencies, and the sets overlap
//       → Jaccard ≥ 0.55 → duplicate
//   • Only one side has tagged currencies (or no overlap)
//       → Jaccard ≥ 0.75 → duplicate (similarity carries the weight)
//   • Neither side has tagged currencies
//       → Jaccard ≥ 0.85 → duplicate (very strict — mostly text)
// ─────────────────────────────────────────────────────────────────────────

/** English + crypto-context stopwords stripped before similarity. */
const DEDUP_STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being",
  "of","to","in","on","at","by","for","with","as","from","about",
  "and","or","but","not","this","that","these","those","it","its",
  "has","have","had","do","does","did","will","would","could","should",
  "after","before","over","under","up","down","out","off","into","onto",
  "now","just","says","said","reports","reported","reportedly","report",
  "via","using","launched","announces","announced","announcement","launch",
  "according","against","amid","amidst","around","because","between",
  "during","since","until","while","through","throughout",
]);

/** Lowercase, strip HTML, tokenize, drop stopwords/short tokens. */
function dedupTokenize(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/g, " ")
      .replace(/[^a-z0-9$\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !DEDUP_STOPWORDS.has(t)),
  );
}

function jaccardSim(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

interface DupCandidateRow {
  id: string;
  title: string;
  matched_currencies: string | null;
  release_time: number;
}

/**
 * Find the canonical event_id this new event duplicates, if any.
 * Returns undefined when this is a fresh, unique story.
 *
 * Search window: 48h prior to the new event's release_time. Caller is
 * expected to invoke this BEFORE classification and persist the result
 * via `markAsDuplicate`.
 */
export function findDuplicateEvent(item: {
  id: string;
  title: string;
  release_time: number;
  matched_currencies: Array<{ currency_id: string }> | null | undefined;
}): { canonical_id: string; similarity: number } | undefined {
  const newTokens = dedupTokenize(item.title);
  // Very short titles (<3 informative tokens) are too noisy for token-set
  // similarity — bail rather than over-match on generic 1-2-word headlines.
  if (newTokens.size < 3) return undefined;

  const newCcy = new Set(
    (item.matched_currencies ?? []).map((c) => c.currency_id),
  );

  const WINDOW_MS = 48 * 60 * 60 * 1000;
  const earliest = item.release_time - WINDOW_MS;

  // Pull candidate events from the same time window. We only consider
  // events that are NOT already marked as duplicates themselves — this
  // ensures we link to the original canonical, not a chain of dups.
  const candidates = db()
    .prepare<[number, number, string], DupCandidateRow>(
      `SELECT id, title, matched_currencies, release_time
       FROM news_events
       WHERE release_time BETWEEN ? AND ?
         AND duplicate_of IS NULL
         AND id != ?
       ORDER BY release_time DESC
       LIMIT 500`,
    )
    .all(earliest, item.release_time, item.id);

  let best: { canonical_id: string; similarity: number } | undefined;

  for (const c of candidates) {
    const cTokens = dedupTokenize(c.title);
    if (cTokens.size < 3) continue;

    const candCcy = new Set(
      ((JSON.parse(c.matched_currencies ?? "[]") as Array<{
        currency_id: string;
      }>)).map((m) => m.currency_id),
    );

    // Determine which similarity bar applies based on currency overlap.
    let threshold: number;
    if (newCcy.size > 0 && candCcy.size > 0) {
      const overlap = [...newCcy].some((x) => candCcy.has(x));
      if (overlap) {
        threshold = 0.55;
      } else {
        // Both have currencies but they DISAGREE — different stories.
        continue;
      }
    } else if (newCcy.size > 0 || candCcy.size > 0) {
      // Asymmetric tagging is common for KOL tweets — be stricter.
      threshold = 0.75;
    } else {
      // Pure-text fallback — only flag if the titles are nearly identical.
      threshold = 0.85;
    }

    const sim = jaccardSim(newTokens, cTokens);
    if (sim >= threshold && (!best || sim > best.similarity)) {
      best = { canonical_id: c.id, similarity: sim };
    }
  }

  return best;
}

/**
 * Mark `eventId` as a duplicate of `canonicalId`. Idempotent —
 * subsequent calls overwrite the pointer.
 */
export function markAsDuplicate(eventId: string, canonicalId: string): void {
  db()
    .prepare(
      `UPDATE news_events SET duplicate_of = ? WHERE id = ?`,
    )
    .run(canonicalId, eventId);
}

/**
 * One-time backfill: scan all events, re-sanitize their title and
 * content fields. Use after deploying the HTML stripping logic to
 * clean the historical SoSoValue search-highlight spans baked into
 * stored rows. Idempotent — running twice is a no-op since the
 * sanitizer is itself idempotent.
 */
export function backfillSanitizeText(): {
  scanned: number;
  cleaned: number;
} {
  interface Row {
    id: string;
    title: string;
    content: string | null;
  }
  const rows = db()
    .prepare<[], Row>(
      `SELECT id, title, content FROM news_events
       WHERE title LIKE '%<%' OR content LIKE '%<%'`,
    )
    .all();

  const updateStmt = db().prepare(
    `UPDATE news_events SET title = ?, content = ? WHERE id = ?`,
  );

  let cleaned = 0;
  const tx = db().transaction(() => {
    for (const r of rows) {
      const newTitle = sanitizeText(r.title) || "(untitled)";
      const newContent = sanitizeText(r.content) || null;
      if (newTitle !== r.title || newContent !== r.content) {
        updateStmt.run(newTitle, newContent, r.id);
        cleaned++;
      }
    }
  });
  tx();
  return { scanned: rows.length, cleaned };
}

/**
 * One-time backfill: scan all classified events, find dups against
 * earlier classified events, mark them. Useful to clean the existing
 * 7%-ish duplicate rate in a populated DB. Idempotent.
 */
export function backfillDuplicates(): {
  scanned: number;
  marked: number;
} {
  interface Row {
    id: string;
    title: string;
    matched_currencies: string | null;
    release_time: number;
  }
  // Process in chronological order so the first occurrence wins as canonical.
  const rows = db()
    .prepare<[], Row>(
      `SELECT id, title, matched_currencies, release_time
       FROM news_events
       WHERE duplicate_of IS NULL
       ORDER BY release_time ASC`,
    )
    .all();

  let marked = 0;
  for (const r of rows) {
    const matched = JSON.parse(r.matched_currencies ?? "[]") as Array<{
      currency_id: string;
    }>;
    const dup = findDuplicateEvent({
      id: r.id,
      title: r.title,
      release_time: r.release_time,
      matched_currencies: matched,
    });
    if (dup) {
      markAsDuplicate(r.id, dup.canonical_id);
      marked++;
    }
  }
  return { scanned: rows.length, marked };
}
