/**
 * Sector index-momentum snapshot.
 *
 * Fetching the live /indices/{ticker}/market-snapshot for every SSI sector
 * index needs ~16 SoSoValue calls, and the client rate-limits to ~20/min — so
 * doing it on the request path blew past the 15s function limit (504, endless
 * "Loading sectors…"). Instead a cron computes it with a long budget and
 * stores it in kv_cache; /api/data/sectors reads the cached value instantly and
 * reports an "as of" time.
 */

import { Indices } from "@/lib/sosovalue";
import { Assets, get, run } from "@/lib/db";

export interface IndexRow {
  ticker: string;
  name: string;
  price: number | null;
  change_pct_24h: number | null;
  roi_7d: number | null;
  roi_1m: number | null;
  roi_3m: number | null;
  roi_1y: number | null;
  ytd: number | null;
}

const KEY = "sector_indices";

/** Live fetch of every SSI sector index (slow — rate-limited, cron-only). */
export async function fetchSectorIndices(): Promise<IndexRow[]> {
  const indexAssets = await Assets.getAssetsByKind("index");
  const indices: IndexRow[] = [];
  for (const a of indexAssets) {
    if (a.sosovalue.kind !== "index") continue;
    const ticker = a.sosovalue.ticker;
    try {
      const snap = await Indices.getIndexMarketSnapshot(ticker);
      indices.push({
        ticker,
        name: a.name,
        price: snap.price ?? null,
        change_pct_24h: snap.change_pct_24h ?? null,
        roi_7d: snap.roi_7d ?? null,
        roi_1m: snap.roi_1m ?? null,
        roi_3m: snap.roi_3m ?? null,
        roi_1y: snap.roi_1y ?? null,
        ytd: snap.ytd ?? null,
      });
    } catch {
      indices.push({
        ticker,
        name: a.name,
        price: null,
        change_pct_24h: null,
        roi_7d: null,
        roi_1m: null,
        roi_3m: null,
        roi_1y: null,
        ytd: null,
      });
    }
  }
  return indices;
}

export async function storeSectorIndices(indices: IndexRow[]): Promise<void> {
  await run(
    `INSERT INTO kv_cache (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [KEY, JSON.stringify(indices), Date.now()],
  );
}

export async function readSectorIndices(): Promise<{
  indices: IndexRow[];
  as_of: number;
} | null> {
  const row = await get<{ value: string; updated_at: number }>(
    `SELECT value, updated_at FROM kv_cache WHERE key = ?`,
    [KEY],
  );
  if (!row) return null;
  try {
    return { indices: JSON.parse(row.value) as IndexRow[], as_of: Number(row.updated_at) };
  } catch {
    return null;
  }
}
