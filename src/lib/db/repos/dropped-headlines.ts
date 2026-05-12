/**
 * Repo for the dropped_headlines table (invariant I-41).
 *
 * Headlines with significance score < 0.25 are persisted here instead of
 * the signals table. Used by /system-health to surface drop-rate and by
 * calibration auditors to spot-check false negatives.
 */

import { db } from "../client";
import type { SignificanceComponents } from "../../calibration/significance";

export interface DroppedHeadline {
  id: string;
  headline_text: string;
  classified_subtype: string | null;
  classified_asset: string | null;
  significance_score: number;
  significance_components: SignificanceComponents;
  significance_reasoning: string | null;
  dropped_at: number;
}

interface DroppedRow {
  id: string;
  headline_text: string;
  classified_subtype: string | null;
  classified_asset: string | null;
  significance_score: number;
  significance_components: string;
  significance_reasoning: string | null;
  dropped_at: number;
}

export function insertDroppedHeadline(d: {
  id: string;
  headline_text: string;
  classified_subtype: string | null;
  classified_asset: string | null;
  significance_score: number;
  significance_components: SignificanceComponents;
  significance_reasoning: string | null;
}): void {
  db()
    .prepare(
      `INSERT OR REPLACE INTO dropped_headlines
         (id, headline_text, classified_subtype, classified_asset,
          significance_score, significance_components, significance_reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      d.id,
      d.headline_text,
      d.classified_subtype,
      d.classified_asset,
      d.significance_score,
      JSON.stringify(d.significance_components),
      d.significance_reasoning,
    );
}

export function listRecentDropped(limit = 50): DroppedHeadline[] {
  const rows = db()
    .prepare<[number], DroppedRow>(
      `SELECT * FROM dropped_headlines ORDER BY dropped_at DESC LIMIT ?`,
    )
    .all(limit);
  return rows.map(rowToDropped);
}

export function countDroppedSince(ts: number): number {
  const r = db()
    .prepare<[number], { c: number }>(
      `SELECT COUNT(*) AS c FROM dropped_headlines WHERE dropped_at >= ?`,
    )
    .get(ts);
  return r?.c ?? 0;
}

function rowToDropped(r: DroppedRow): DroppedHeadline {
  return {
    id: r.id,
    headline_text: r.headline_text,
    classified_subtype: r.classified_subtype,
    classified_asset: r.classified_asset,
    significance_score: r.significance_score,
    significance_components: JSON.parse(r.significance_components),
    significance_reasoning: r.significance_reasoning,
    dropped_at: r.dropped_at,
  };
}
