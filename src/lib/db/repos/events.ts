/**
 * Repository — `news_events`, `event_assets`.
 *
 * The ingest worker uses `upsertEvent` to write items idempotently; the
 * dashboard uses `listRecentEvents` to render the activity feed.
 *
 * Wave 2: async (libSQL/Turso). Every function awaits.
 */

import { all, get, run, batch } from "../client";
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

import { sanitizeText as pipelineSanitize } from "@/lib/pipeline/ingestion-validation";
function sanitizeText(s: string | null | undefined): string {
  return pipelineSanitize(s);
}

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
 * Returns whether it was newly inserted (true) or already present (false).
 */
export async function upsertEvent(
  item: NewsItem,
): Promise<{ inserted: boolean }> {
  const exists = await get<{ id: string }>(
    "SELECT id FROM news_events WHERE id = ?",
    [item.id],
  );

  await run(
    `INSERT INTO news_events (
       id, release_time, title, content, author, source_link, original_link,
       category, tags, matched_currencies,
       impression_count, like_count, retweet_count, is_blue_verified,
       raw_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       content = excluded.content,
       tags = excluded.tags,
       matched_currencies = excluded.matched_currencies`,
    [
      item.id,
      toMs(item.release_time),
      deriveTitle(item.title, item.content),
      sanitizeText(item.content) || null,
      item.author ?? null,
      item.source_link ?? null,
      item.original_link ?? null,
      item.category,
      JSON.stringify(item.tags ?? []),
      JSON.stringify(item.matched_currencies ?? []),
      item.impression_count ?? null,
      item.like_count ?? null,
      item.retweet_count ?? null,
      item.is_blue_verified ? 1 : 0,
      JSON.stringify(item),
    ],
  );

  return { inserted: !exists };
}

/**
 * Link an event to its asset_ids (in event_assets).
 * `source` distinguishes "matched" (from SoSoValue) vs "inferred" (Claude).
 */
export async function linkEventAssets(
  eventId: string,
  assetIds: string[],
  source: "matched" | "inferred",
): Promise<void> {
  if (assetIds.length === 0) return;
  await batch(
    assetIds.map((id) => ({
      sql: `INSERT OR IGNORE INTO event_assets (event_id, asset_id, source) VALUES (?, ?, ?)`,
      args: [eventId, id, source],
    })),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Read paths
// ─────────────────────────────────────────────────────────────────────────

export async function getEventById(
  id: string,
): Promise<StoredEvent | undefined> {
  const row = await get<EventRow>(
    "SELECT * FROM news_events WHERE id = ?",
    [id],
  );
  return row ? rowToEvent(row) : undefined;
}

export async function listRecentEvents(opts?: {
  limit?: number;
  category?: number;
  assetId?: string;
}): Promise<StoredEvent[]> {
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

  const rows = await all<EventRow>(sql, params);
  return rows.map(rowToEvent);
}

/** How many events have NOT been classified yet. */
export async function countUnclassifiedEvents(): Promise<number> {
  const row = await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM news_events n
     LEFT JOIN classifications c ON c.event_id = n.id
     LEFT JOIN skipped_pre_classify s ON s.id = n.id
     WHERE c.event_id IS NULL
       AND s.id IS NULL
       AND n.duplicate_of IS NULL`,
  );
  return row?.n ?? 0;
}

/** Iterate the unclassified events for the classifier. */
export async function getUnclassifiedEvents(
  limit = 50,
): Promise<StoredEvent[]> {
  const rows = await all<EventRow>(
    `SELECT n.* FROM news_events n
     LEFT JOIN classifications c ON c.event_id = n.id
     LEFT JOIN skipped_pre_classify s ON s.id = n.id
     WHERE c.event_id IS NULL
       AND s.id IS NULL
       AND n.duplicate_of IS NULL
     ORDER BY n.release_time DESC
     LIMIT ?`,
    [limit],
  );
  return rows.map(rowToEvent);
}

// ─────────────────────────────────────────────────────────────────────────
// Content-level deduplication
// ─────────────────────────────────────────────────────────────────────────

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

export async function findDuplicateEvent(item: {
  id: string;
  title: string;
  release_time: number;
  matched_currencies: Array<{ currency_id: string }> | null | undefined;
}): Promise<{ canonical_id: string; similarity: number } | undefined> {
  const newTokens = dedupTokenize(item.title);
  if (newTokens.size < 3) return undefined;

  const newCcy = new Set(
    (item.matched_currencies ?? []).map((c) => c.currency_id),
  );

  const WINDOW_MS = 48 * 60 * 60 * 1000;
  const earliest = item.release_time - WINDOW_MS;

  const candidates = await all<DupCandidateRow>(
    `SELECT id, title, matched_currencies, release_time
     FROM news_events
     WHERE release_time BETWEEN ? AND ?
       AND duplicate_of IS NULL
       AND id != ?
     ORDER BY release_time DESC
     LIMIT 500`,
    [earliest, item.release_time, item.id],
  );

  let best: { canonical_id: string; similarity: number } | undefined;

  for (const c of candidates) {
    const cTokens = dedupTokenize(c.title);
    if (cTokens.size < 3) continue;

    const candCcy = new Set(
      (JSON.parse(c.matched_currencies ?? "[]") as Array<{
        currency_id: string;
      }>).map((m) => m.currency_id),
    );

    let threshold: number;
    if (newCcy.size > 0 && candCcy.size > 0) {
      const overlap = [...newCcy].some((x) => candCcy.has(x));
      if (overlap) {
        threshold = 0.55;
      } else {
        continue;
      }
    } else if (newCcy.size > 0 || candCcy.size > 0) {
      threshold = 0.75;
    } else {
      threshold = 0.85;
    }

    const sim = jaccardSim(newTokens, cTokens);
    if (sim >= threshold && (!best || sim > best.similarity)) {
      best = { canonical_id: c.id, similarity: sim };
    }
  }

  return best;
}

export async function markAsDuplicate(
  eventId: string,
  canonicalId: string,
): Promise<void> {
  await run(`UPDATE news_events SET duplicate_of = ? WHERE id = ?`, [
    canonicalId,
    eventId,
  ]);
}

/**
 * One-time backfill: scan all events, re-sanitize their title and
 * content fields. Idempotent.
 */
export async function backfillSanitizeText(): Promise<{
  scanned: number;
  cleaned: number;
}> {
  interface Row {
    id: string;
    title: string;
    content: string | null;
  }
  const rows = await all<Row>(
    `SELECT id, title, content FROM news_events
     WHERE title LIKE '%<%' OR content LIKE '%<%'`,
  );

  const updates: Array<{ sql: string; args: (string | null)[] }> = [];
  for (const r of rows) {
    const newTitle = sanitizeText(r.title) || "(untitled)";
    const newContent = sanitizeText(r.content) || null;
    if (newTitle !== r.title || newContent !== r.content) {
      updates.push({
        sql: `UPDATE news_events SET title = ?, content = ? WHERE id = ?`,
        args: [newTitle, newContent, r.id],
      });
    }
  }
  if (updates.length > 0) await batch(updates);
  return { scanned: rows.length, cleaned: updates.length };
}

/**
 * One-time backfill: scan all classified events, find dups, mark them.
 */
export async function backfillDuplicates(): Promise<{
  scanned: number;
  marked: number;
}> {
  interface Row {
    id: string;
    title: string;
    matched_currencies: string | null;
    release_time: number;
  }
  const rows = await all<Row>(
    `SELECT id, title, matched_currencies, release_time
     FROM news_events
     WHERE duplicate_of IS NULL
     ORDER BY release_time ASC`,
  );

  let marked = 0;
  for (const r of rows) {
    const matched = JSON.parse(r.matched_currencies ?? "[]") as Array<{
      currency_id: string;
    }>;
    const dup = await findDuplicateEvent({
      id: r.id,
      title: r.title,
      release_time: r.release_time,
      matched_currencies: matched,
    });
    if (dup) {
      await markAsDuplicate(r.id, dup.canonical_id);
      marked++;
    }
  }
  return { scanned: rows.length, marked };
}
