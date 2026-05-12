/**
 * Skip the historical pending backlog so the classifier can catch up in
 * real-time. Keeps the most recent N pending events (default 50) for
 * processing; marks everything older as backlog-skipped.
 *
 * Mechanism: bulk-insert rows into `skipped_pre_classify` with a
 * distinct `reasoning` marker so future audits can tell these apart
 * from real corpus-gate drops. After this runs, `getUnclassifiedEvents`
 * will only return the most recent 50 — and the cron classifier will
 * catch up to real-time on its next firing.
 *
 * Reversible: a future run of /api/cron/ingest-news?reclassify=1 will
 * re-classify these rows (the reclassify path bypasses the gate). The
 * `skipped_pre_classify` rows stay for forensics either way.
 *
 * Usage:
 *   npx tsx scripts/skip-backlog.ts            # keep newest 50
 *   npx tsx scripts/skip-backlog.ts --keep 100 # keep newest 100
 */

import { db } from "../src/lib/db";

const REASON = "backlog_skip — fast-forward to real-time after corpus gate ship";

const keepArgIdx = process.argv.indexOf("--keep");
const keep =
  keepArgIdx >= 0 && Number.isFinite(Number(process.argv[keepArgIdx + 1]))
    ? Number(process.argv[keepArgIdx + 1])
    : 50;

console.log(`[skip-backlog] keeping newest ${keep} pending events.`);

// Find every pending event NOT in the most-recent-N window.
interface Row {
  id: string;
  title: string;
  release_time: number;
}
const candidates = db()
  .prepare<[number], Row>(
    `SELECT n.id, n.title, n.release_time
     FROM news_events n
     LEFT JOIN classifications c ON c.event_id = n.id
     LEFT JOIN skipped_pre_classify s ON s.id = n.id
     WHERE c.event_id IS NULL
       AND s.id IS NULL
       AND n.duplicate_of IS NULL
     ORDER BY n.release_time DESC
     LIMIT -1 OFFSET ?`,
  )
  .all(keep);

console.log(`[skip-backlog] ${candidates.length} pending events older than the keep-window.`);
if (candidates.length === 0) {
  console.log(`[skip-backlog] nothing to do — backlog is already drained.`);
  process.exit(0);
}

const insert = db().prepare(
  `INSERT OR IGNORE INTO skipped_pre_classify
     (id, headline_text, corpus_score, max_cosine, top_match_event_id,
      asset_classes_detected, asset_class_in_corpus, reasoning, skipped_at)
   VALUES (?, ?, 0, 0, NULL, '[]', 0, ?, ?)`,
);

let inserted = 0;
const txn = db().transaction(() => {
  for (const r of candidates) {
    const res = insert.run(r.id, r.title, REASON, Date.now());
    if (res.changes > 0) inserted++;
  }
});
txn();

console.log(`[skip-backlog] marked ${inserted} events as backlog-skipped.`);
console.log(`[skip-backlog] verifying remaining pending count...`);

const after = db()
  .prepare<[], { n: number }>(
    `SELECT COUNT(*) AS n FROM news_events n
     LEFT JOIN classifications c ON c.event_id = n.id
     LEFT JOIN skipped_pre_classify s ON s.id = n.id
     WHERE c.event_id IS NULL
       AND s.id IS NULL
       AND n.duplicate_of IS NULL`,
  )
  .get();

console.log(`[skip-backlog] pending now: ${after?.n ?? "?"} (target: ≤ ${keep}).`);
console.log(`[skip-backlog] OK.`);
