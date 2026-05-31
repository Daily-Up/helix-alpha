/**
 * Repo for `skipped_pre_classify`. Wave 2: async.
 */

import { all, get, run } from "../client";

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

export async function insertSkipped(input: {
  id: string;
  headline_text: string;
  corpus_score: number;
  max_cosine: number;
  top_match_event_id: string | null;
  asset_classes_detected: string[];
  asset_class_in_corpus: boolean;
  reasoning: string;
}): Promise<void> {
  await run(
    `INSERT OR REPLACE INTO skipped_pre_classify
       (id, headline_text, corpus_score, max_cosine, top_match_event_id,
        asset_classes_detected, asset_class_in_corpus, reasoning)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.headline_text,
      input.corpus_score,
      input.max_cosine,
      input.top_match_event_id,
      JSON.stringify(input.asset_classes_detected),
      input.asset_class_in_corpus ? 1 : 0,
      input.reasoning,
    ],
  );
}

export async function listRecentSkipped(
  limit = 50,
): Promise<SkippedPreClassifyRow[]> {
  const rows = await all<RawRow>(
    `SELECT * FROM skipped_pre_classify ORDER BY skipped_at DESC LIMIT ?`,
    [limit],
  );
  return rows.map(toRow);
}

export async function countSkippedSince(ts: number): Promise<number> {
  const r = await get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM skipped_pre_classify WHERE skipped_at >= ?`,
    [ts],
  );
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
