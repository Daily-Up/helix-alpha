/**
 * Repo for `skipped_pre_classify` (invariant I-46).
 *
 * Headlines that fail the corpus-similarity gate land here instead of in
 * `classifications`. Used by audit pages + drop-rate stats on
 * /system-health.
 */

import { db } from "../client";

export interface SkippedPreClassifyRow {
  id: string;
  headline_text: string;
  corpus_score: number;
  max_cosine: number;
  top_match_event_id: string | null;
  asset_classes_detected: string[];
  asset_class_in_corpus: boolean;
  reasoning: string;
  skipped_at: number;
}

interface RawRow {
  id: string;
  headline_text: string;
  corpus_score: number;
  max_cosine: number;
  top_match_event_id: string | null;
  asset_classes_detected: string;
  asset_class_in_corpus: number;
  reasoning: string;
  skipped_at: number;
}

export function insertSkipped(input: {
  id: string;
  headline_text: string;
  corpus_score: number;
  max_cosine: number;
  top_match_event_id: string | null;
  asset_classes_detected: string[];
  asset_class_in_corpus: boolean;
  reasoning: string;
}): void {
  db()
    .prepare(
      `INSERT OR REPLACE INTO skipped_pre_classify
         (id, headline_text, corpus_score, max_cosine, top_match_event_id,
          asset_classes_detected, asset_class_in_corpus, reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.headline_text,
      input.corpus_score,
      input.max_cosine,
      input.top_match_event_id,
      JSON.stringify(input.asset_classes_detected),
      input.asset_class_in_corpus ? 1 : 0,
      input.reasoning,
    );
}

export function listRecentSkipped(limit = 50): SkippedPreClassifyRow[] {
  const rows = db()
    .prepare<[number], RawRow>(
      `SELECT * FROM skipped_pre_classify ORDER BY skipped_at DESC LIMIT ?`,
    )
    .all(limit);
  return rows.map(toRow);
}

export function countSkippedSince(ts: number): number {
  const r = db()
    .prepare<[number], { c: number }>(
      `SELECT COUNT(*) AS c FROM skipped_pre_classify WHERE skipped_at >= ?`,
    )
    .get(ts);
  return r?.c ?? 0;
}

function toRow(r: RawRow): SkippedPreClassifyRow {
  return {
    id: r.id,
    headline_text: r.headline_text,
    corpus_score: r.corpus_score,
    max_cosine: r.max_cosine,
    top_match_event_id: r.top_match_event_id,
    asset_classes_detected: JSON.parse(r.asset_classes_detected),
    asset_class_in_corpus: r.asset_class_in_corpus === 1,
    reasoning: r.reasoning,
    skipped_at: r.skipped_at,
  };
}
