/**
 * Repository — `assets` table.
 *
 * Idempotent upsert from the in-memory universe to persistent storage,
 * plus typed lookups used by the UI and ingest worker.
 */

import { db } from "../client";
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

/** Upsert one asset. */
export function upsertAsset(asset: Asset): void {
  const stmt = db().prepare(
    `INSERT INTO assets (id, symbol, name, kind, tags, routing, tradable, rank, updated_at)
     VALUES (@id, @symbol, @name, @kind, @tags, @routing, @tradable, @rank, unixepoch() * 1000)
     ON CONFLICT(id) DO UPDATE SET
       symbol     = excluded.symbol,
       name       = excluded.name,
       kind       = excluded.kind,
       tags       = excluded.tags,
       routing    = excluded.routing,
       tradable   = excluded.tradable,
       rank       = excluded.rank,
       updated_at = excluded.updated_at`,
  );
  stmt.run({
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    kind: asset.kind,
    tags: JSON.stringify(asset.tags),
    routing: JSON.stringify(asset.sosovalue),
    tradable: asset.tradable ? JSON.stringify(asset.tradable) : null,
    rank: asset.rank ?? null,
  });
}

/** Get all assets that have a SoDEX trading pair. */
export function getTradableAssets(): Asset[] {
  const rows = db()
    .prepare<[], AssetRow>(
      "SELECT * FROM assets WHERE tradable IS NOT NULL ORDER BY rank DESC NULLS LAST, symbol",
    )
    .all();
  return rows.map(rowToAsset);
}

/** Bulk-upsert in a single transaction. */
export function upsertAssets(assets: Asset[]): void {
  const tx = db().transaction((items: Asset[]) => {
    for (const a of items) upsertAsset(a);
  });
  tx(assets);
}

/** Get an asset by its internal id. */
export function getAssetById(id: string): Asset | undefined {
  const row = db()
    .prepare<[string], AssetRow>("SELECT * FROM assets WHERE id = ?")
    .get(id);
  return row ? rowToAsset(row) : undefined;
}

/** Get all assets. */
export function getAllAssets(): Asset[] {
  const rows = db()
    .prepare<[], AssetRow>("SELECT * FROM assets ORDER BY rank DESC NULLS LAST, symbol")
    .all();
  return rows.map(rowToAsset);
}

/** Get assets by kind. */
export function getAssetsByKind(kind: AssetKindValue): Asset[] {
  const rows = db()
    .prepare<[AssetKindValue], AssetRow>(
      "SELECT * FROM assets WHERE kind = ? ORDER BY rank DESC NULLS LAST, symbol",
    )
    .all(kind);
  return rows.map(rowToAsset);
}

/**
 * Look up an asset by SoSoValue currency_id (for tokens/RWA only).
 * Used by the ingest worker to map news.matched_currencies → asset_id.
 */
export function getAssetByCurrencyId(currencyId: string): Asset | undefined {
  const row = db()
    .prepare<[string], AssetRow>(
      `SELECT * FROM assets
       WHERE kind IN ('token','rwa')
         AND json_extract(routing, '$.currency_id') = ?`,
    )
    .get(currencyId);
  return row ? rowToAsset(row) : undefined;
}

/** Look up by ticker (ETFs, stocks, treasuries, indexes). */
export function getAssetByTicker(ticker: string): Asset | undefined {
  const row = db()
    .prepare<[string], AssetRow>(
      `SELECT * FROM assets
       WHERE json_extract(routing, '$.ticker') = ?
       LIMIT 1`,
    )
    .get(ticker);
  return row ? rowToAsset(row) : undefined;
}
