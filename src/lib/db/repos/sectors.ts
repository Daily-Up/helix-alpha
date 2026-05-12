/**
 * Repository — `sector_snapshots`.
 *
 * /currencies/sector-spotlight is point-in-time. We snapshot it on the
 * cron and keep history so the narrative-cycle module can plot dominance
 * over time and detect rotation.
 */

import { db } from "../client";
import type { SectorEntry } from "@/lib/sosovalue";

export function snapshotSectors(at: number, sectors: SectorEntry[]): number {
  if (sectors.length === 0) return 0;
  const stmt = db().prepare(
    `INSERT INTO sector_snapshots (snapshot_at, sector_name, change_pct_24h, marketcap_dom)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(snapshot_at, sector_name) DO UPDATE SET
       change_pct_24h = excluded.change_pct_24h,
       marketcap_dom  = excluded.marketcap_dom`,
  );
  const tx = db().transaction((items: SectorEntry[]) => {
    let n = 0;
    for (const s of items) {
      stmt.run(at, s.name, s.change_pct_24h ?? null, s.marketcap_dom ?? null);
      n++;
    }
    return n;
  });
  return tx(sectors);
}

export interface SectorSnapshotRow {
  snapshot_at: number;
  sector_name: string;
  change_pct_24h: number | null;
  marketcap_dom: number | null;
}

/** Latest snapshot per sector. */
export function getLatestSectors(): SectorSnapshotRow[] {
  return db()
    .prepare<[], SectorSnapshotRow>(
      `SELECT s1.*
       FROM sector_snapshots s1
       INNER JOIN (
         SELECT sector_name, MAX(snapshot_at) AS max_at
         FROM sector_snapshots GROUP BY sector_name
       ) s2 ON s1.sector_name = s2.sector_name AND s1.snapshot_at = s2.max_at
       ORDER BY s1.marketcap_dom DESC`,
    )
    .all();
}

/** Time series for one sector. */
export function getSectorHistory(
  sectorName: string,
  limit = 168,
): SectorSnapshotRow[] {
  return db()
    .prepare<[string, number], SectorSnapshotRow>(
      `SELECT * FROM sector_snapshots
       WHERE sector_name = ?
       ORDER BY snapshot_at DESC
       LIMIT ?`,
    )
    .all(sectorName, limit);
}
