/**
 * Query recent signal headlines for novelty scoring (Phase C).
 *
 * The significance scorer's Component 3 (novelty, 20%) needs the set of
 * recent signals on the same asset to detect repeated coverage. We expose
 * a small DB-aware helper here so `significance.ts` stays pure and easily
 * testable in isolation.
 */

import { db } from "../db/client";

interface Row {
  title: string;
}

/**
 * Fetch the titles of all signals fired on `assetId` in the last `windowMs`
 * (default 7 days). Joins through triggered_by_event_id → news_events.title.
 */
export function recentHeadlinesForAsset(
  assetId: string,
  windowMs: number = 7 * 24 * 60 * 60 * 1000,
  now: number = Date.now(),
): string[] {
  const since = now - windowMs;
  const rows = db()
    .prepare<[string, number], Row>(
      `SELECT n.title
       FROM signals s
       LEFT JOIN news_events n ON n.id = s.triggered_by_event_id
       WHERE s.asset_id = ?
         AND s.fired_at >= ?
         AND n.title IS NOT NULL
       ORDER BY s.fired_at DESC`,
    )
    .all(assetId, since);
  return rows.map((r) => r.title);
}
