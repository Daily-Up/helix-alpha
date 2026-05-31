/**
 * Repository — `impact_metrics`. Wave 2: async.
 */

import { all, get, run } from "../client";

export interface ImpactRow {
  event_id: string;
  asset_id: string;
  price_t0: number | null;
  price_t1d: number | null;
  price_t3d: number | null;
  price_t7d: number | null;
  impact_pct_1d: number | null;
  impact_pct_3d: number | null;
  impact_pct_7d: number | null;
  computed_at: number;
}

export async function upsertImpact(
  row: Omit<ImpactRow, "computed_at">,
): Promise<void> {
  await run(
    `INSERT INTO impact_metrics (
       event_id, asset_id,
       price_t0, price_t1d, price_t3d, price_t7d,
       impact_pct_1d, impact_pct_3d, impact_pct_7d
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, asset_id) DO UPDATE SET
       price_t0       = excluded.price_t0,
       price_t1d      = excluded.price_t1d,
       price_t3d      = excluded.price_t3d,
       price_t7d      = excluded.price_t7d,
       impact_pct_1d  = excluded.impact_pct_1d,
       impact_pct_3d  = excluded.impact_pct_3d,
       impact_pct_7d  = excluded.impact_pct_7d,
       computed_at    = unixepoch() * 1000`,
    [
      row.event_id,
      row.asset_id,
      row.price_t0,
      row.price_t1d,
      row.price_t3d,
      row.price_t7d,
      row.impact_pct_1d,
      row.impact_pct_3d,
      row.impact_pct_7d,
    ],
  );
}

export async function getPendingImpactEvents(limit = 2000): Promise<Array<{
  event_id: string;
  release_time: number;
  asset_id: string;
}>> {
  return all<{ event_id: string; release_time: number; asset_id: string }>(
    `SELECT DISTINCT n.id AS event_id, n.release_time, ea.asset_id
     FROM news_events n
     JOIN classifications c ON c.event_id = n.id
     JOIN event_assets ea   ON ea.event_id = n.id
     JOIN assets a          ON a.id       = ea.asset_id
     LEFT JOIN impact_metrics im
       ON im.event_id = n.id AND im.asset_id = ea.asset_id
     WHERE im.event_id IS NULL
       AND a.kind IN ('token', 'rwa', 'stock')
     ORDER BY n.release_time ASC
     LIMIT ?`,
    [limit],
  );
}

export async function getImpact(
  eventId: string,
  assetId: string,
): Promise<ImpactRow | undefined> {
  return get<ImpactRow>(
    `SELECT * FROM impact_metrics WHERE event_id = ? AND asset_id = ?`,
    [eventId, assetId],
  );
}

export async function aggregateByEventType(
  horizon: "1d" | "3d" | "7d",
  minSamples = 3,
): Promise<Array<{
  event_type: string;
  asset_id: string | null;
  n: number;
  avg: number;
  median: number;
  stddev: number;
}>> {
  const col = `impact_pct_${horizon}`;

  type Row = {
    event_type: string;
    asset_id: string;
    impact: number;
  };
  const rows = await all<Row>(
    `SELECT c.event_type AS event_type,
            im.asset_id  AS asset_id,
            im.${col}    AS impact
     FROM impact_metrics im
     JOIN classifications c ON c.event_id = im.event_id
     WHERE im.${col} IS NOT NULL`,
  );

  const groups = new Map<string, number[]>();
  for (const r of rows) {
    if (!groups.has(r.event_type)) groups.set(r.event_type, []);
    groups.get(r.event_type)!.push(r.impact);
  }

  const out: Array<{
    event_type: string;
    asset_id: string | null;
    n: number;
    avg: number;
    median: number;
    stddev: number;
  }> = [];
  for (const [event_type, samples] of groups) {
    if (samples.length < minSamples) continue;
    const sorted = [...samples].sort((a, b) => a - b);
    const n = samples.length;
    const avg = samples.reduce((s, v) => s + v, 0) / n;
    const median =
      n % 2 === 0
        ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
        : sorted[(n - 1) / 2];
    const variance = samples.reduce((s, v) => s + (v - avg) ** 2, 0) / n;
    const stddev = Math.sqrt(variance);
    out.push({ event_type, asset_id: null, n, avg, median, stddev });
  }

  return out.sort((a, b) => Math.abs(b.avg) - Math.abs(a.avg));
}
