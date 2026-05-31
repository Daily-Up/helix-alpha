/**
 * Repository — `assets` table.
 *
 * Idempotent upsert from the in-memory universe to persistent storage,
 * plus typed lookups used by the UI and ingest worker.
 *
 * Wave 2: now async (libSQL/Turso). Callers must `await` every function.
 */

import { all, get, run, batch } from "../client";
import type { Asset, AssetKindValue } from "@/lib/universe";

interface AssetRow {
  id: string;
  symbol: string;
  name: string;
  kind: AssetKindValue;
  tags: string;
  routing: string;
  tradable: string | null;
  rank: number | null;
  created_at: number;
  updated_at: number;
}

function rowToAsset(row: AssetRow): Asset {
  // The SQL column is `routing` (a more general name); the runtime Asset
  // type uses `sosovalue`. We do the conversion here so callers don't see
  // the database-internal naming.
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    kind: row.kind,
    tags: JSON.parse(row.tags) as Asset["tags"],
    sosovalue: JSON.parse(row.routing) as Asset["sosovalue"],
    tradable: row.tradable
      ? (JSON.parse(row.tradable) as Asset["tradable"])
      : undefined,
    rank: row.rank ?? undefined,
  };
}

const UPSERT_SQL = `INSERT INTO assets (id, symbol, name, kind, tags, routing, tradable, rank, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch() * 1000)
   ON CONFLICT(id) DO UPDATE SET
     symbol     = excluded.symbol,
     name       = excluded.name,
     kind       = excluded.kind,
     tags       = excluded.tags,
     routing    = excluded.routing,
     tradable   = excluded.tradable,
     rank       = excluded.rank,
     updated_at = excluded.updated_at`;

function assetToArgs(a: Asset): (string | number | null)[] {
  return [
    a.id,
    a.symbol,
    a.name,
    a.kind,
    JSON.stringify(a.tags),
    JSON.stringify(a.sosovalue),
    a.tradable ? JSON.stringify(a.tradable) : null,
    a.rank ?? null,
  ];
}

/** Upsert one asset. */
export async function upsertAsset(asset: Asset): Promise<void> {
  await run(UPSERT_SQL, assetToArgs(asset));
}

/** Get all assets that have a SoDEX trading pair. */
export async function getTradableAssets(): Promise<Asset[]> {
  const rows = await all<AssetRow>(
    "SELECT * FROM assets WHERE tradable IS NOT NULL ORDER BY rank DESC NULLS LAST, symbol",
  );
  return rows.map(rowToAsset);
}

/** Bulk-upsert in a single transaction. */
export async function upsertAssets(assets: Asset[]): Promise<void> {
  if (assets.length === 0) return;
  await batch(
    assets.map((a) => ({ sql: UPSERT_SQL, args: assetToArgs(a) })),
  );
}

/** Get an asset by its internal id. */
export async function getAssetById(id: string): Promise<Asset | undefined> {
  const row = await get<AssetRow>("SELECT * FROM assets WHERE id = ?", [id]);
  return row ? rowToAsset(row) : undefined;
}

/** Get all assets. */
export async function getAllAssets(): Promise<Asset[]> {
  const rows = await all<AssetRow>(
    "SELECT * FROM assets ORDER BY rank DESC NULLS LAST, symbol",
  );
  return rows.map(rowToAsset);
}

/** Get assets by kind. */
export async function getAssetsByKind(
  kind: AssetKindValue,
): Promise<Asset[]> {
  const rows = await all<AssetRow>(
    "SELECT * FROM assets WHERE kind = ? ORDER BY rank DESC NULLS LAST, symbol",
    [kind],
  );
  return rows.map(rowToAsset);
}

/**
 * Look up an asset by SoSoValue currency_id (for tokens/RWA only).
 * Used by the ingest worker to map news.matched_currencies → asset_id.
 */
export async function getAssetByCurrencyId(
  currencyId: string,
): Promise<Asset | undefined> {
  const row = await get<AssetRow>(
    `SELECT * FROM assets
     WHERE kind IN ('token','rwa')
       AND json_extract(routing, '$.currency_id') = ?`,
    [currencyId],
  );
  return row ? rowToAsset(row) : undefined;
}

/** Look up by ticker (ETFs, stocks, treasuries, indexes). */
export async function getAssetByTicker(
  ticker: string,
): Promise<Asset | undefined> {
  const row = await get<AssetRow>(
    `SELECT * FROM assets
     WHERE json_extract(routing, '$.ticker') = ?
     LIMIT 1`,
    [ticker],
  );
  return row ? rowToAsset(row) : undefined;
}
