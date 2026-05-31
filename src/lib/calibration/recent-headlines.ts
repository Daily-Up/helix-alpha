/**
 * Query recent signal headlines for novelty scoring (Phase C). Wave 2: async.
 */

import { all } from "../db/client";

interface Row {
  title: string;
}

export async function recentHeadlinesForAsset(
  assetId: string,
  windowMs: number = 7 * 24 * 60 * 60 * 1000,
  now: number = Date.now(),
): Promise<string[]> {
  const since = now - windowMs;
  const rows = await all<Row>(
    `SELECT n.title
     FROM signals s
     LEFT JOIN news_events n ON n.id = s.triggered_by_event_id
     WHERE s.asset_id = ?
       AND s.fired_at >= ?
       AND n.title IS NOT NULL
     ORDER BY s.fired_at DESC`,
    [assetId, since],
  );
  return rows.map((r) => r.title);
}
