/**
 * Repository — `sector_snapshots`. Wave 2: async.
 */

import { all, batch } from "../client";
import type { SectorEntry } from "@/lib/sosovalue";

export async function snapshotSectors(
  at: number,
  sectors: SectorEntry[],
): Promise<number> {
  if (sectors.length === 0) return 0;
  const sql = `INSERT INTO sector_snapshots (snapshot_at, sector_name, change_pct_24h, marketcap_dom)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(snapshot_at, sector_name) DO UPDATE SET
                 change_pct_24h = excluded.change_pct_24h,
                 marketcap_dom  = excluded.marketcap_dom`;
  await batch(
    sectors.map((s) => ({
      sql,
      args: [at, s.name, s.change_pct_24h ?? null, s.marketcap_dom ?? null],
    })),
  );
  return sectors.length;
}

export interface SectorSnapshotRow {
  snapshot_at: number;
  sector_name: string;
  change_pct_24h: number | null;
  marketcap_dom: number | null;
}

export async function getLatestSectors(): Promise<SectorSnapshotRow[]> {
  return all<SectorSnapshotRow>(
    `SELECT s1.*
     FROM sector_snapshots s1
     INNER JOIN (
       SELECT sector_name, MAX(snapshot_at) AS max_at
       FROM sector_snapshots GROUP BY sector_name
     ) s2 ON s1.sector_name = s2.sector_name AND s1.snapshot_at = s2.max_at
     ORDER BY s1.marketcap_dom DESC`,
  );
}

export async function getSectorHistory(
  sectorName: string,
  limit = 168,
): Promise<SectorSnapshotRow[]> {
  return all<SectorSnapshotRow>(
    `SELECT * FROM sector_snapshots
     WHERE sector_name = ?
     ORDER BY snapshot_at DESC
     LIMIT ?`,
    [sectorName, limit],
  );
}
