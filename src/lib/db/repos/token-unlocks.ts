/**
 * Repository — `token_unlocks` table.
 *
 * Forward calendar of scheduled token supply unlocks (DefiLlama emissions).
 * Idempotent upsert on the synthetic id "<slug>-<YYYY-MM-DD>". Rows with a
 * resolved `asset_id` + `tradable_perp=1` are eligible to become SHORT
 * signals; the rest exist for calendar completeness.
 *
 * Wave 3: async (libSQL/Turso).
 */

import { all, get, batch } from "../client";

export interface TokenUnlockRow {
  id: string;
  protocol_slug: string;
  token_id: string | null;
  symbol: string;
  asset_id: string | null;
  sodex_symbol: string | null;
  tradable_perp: number; // 0 | 1
  unlock_at: number; // ms epoch
  unlock_date: string; // YYYY-MM-DD
  unlock_kind: string | null; // cliff | linear | mixed
  tokens_unlocked: number | null;
  unlock_value_usd: number | null;
  price_usd: number | null;
  pct_of_circulating: number | null; // percent
  pct_of_max_supply: number | null; // percent
  categories_json: string | null;
  source: string | null;
  raw_json: string | null;
  ingested_at: number;
  updated_at: number;
}

export type NewTokenUnlock = Omit<
  TokenUnlockRow,
  "ingested_at" | "updated_at"
>;

const UPSERT_SQL = `INSERT INTO token_unlocks (
    id, protocol_slug, token_id, symbol, asset_id, sodex_symbol, tradable_perp,
    unlock_at, unlock_date, unlock_kind, tokens_unlocked, unlock_value_usd,
    price_usd, pct_of_circulating, pct_of_max_supply, categories_json,
    source, raw_json, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch() * 1000)
  ON CONFLICT(id) DO UPDATE SET
    protocol_slug      = excluded.protocol_slug,
    token_id           = excluded.token_id,
    symbol             = excluded.symbol,
    asset_id           = excluded.asset_id,
    sodex_symbol       = excluded.sodex_symbol,
    tradable_perp      = excluded.tradable_perp,
    unlock_at          = excluded.unlock_at,
    unlock_date        = excluded.unlock_date,
    unlock_kind        = excluded.unlock_kind,
    tokens_unlocked    = excluded.tokens_unlocked,
    unlock_value_usd   = excluded.unlock_value_usd,
    price_usd          = excluded.price_usd,
    pct_of_circulating = excluded.pct_of_circulating,
    pct_of_max_supply  = excluded.pct_of_max_supply,
    categories_json    = excluded.categories_json,
    source             = excluded.source,
    raw_json           = excluded.raw_json,
    updated_at         = excluded.updated_at`;

function toArgs(u: NewTokenUnlock): (string | number | null)[] {
  return [
    u.id,
    u.protocol_slug,
    u.token_id ?? null,
    u.symbol,
    u.asset_id ?? null,
    u.sodex_symbol ?? null,
    u.tradable_perp ? 1 : 0,
    u.unlock_at,
    u.unlock_date,
    u.unlock_kind ?? null,
    u.tokens_unlocked ?? null,
    u.unlock_value_usd ?? null,
    u.price_usd ?? null,
    u.pct_of_circulating ?? null,
    u.pct_of_max_supply ?? null,
    u.categories_json ?? null,
    u.source ?? null,
    u.raw_json ?? null,
  ];
}

/** Upsert a batch of unlock rows in one transaction. */
export async function upsertUnlocks(rows: NewTokenUnlock[]): Promise<void> {
  if (rows.length === 0) return;
  await batch(rows.map((u) => ({ sql: UPSERT_SQL, args: toArgs(u) })));
}

export async function getUnlock(
  id: string,
): Promise<TokenUnlockRow | undefined> {
  return get<TokenUnlockRow>("SELECT * FROM token_unlocks WHERE id = ?", [id]);
}

/**
 * Upcoming unlocks (unlock_at in the future), soonest first.
 *
 *  - `withinMs`      only unlocks within this window from now
 *  - `tradableOnly`  only rows with a resolved SoDEX perp (shortable)
 *  - `limit`         cap the result set
 */
export async function upcomingUnlocks(opts?: {
  withinMs?: number;
  tradableOnly?: boolean;
  limit?: number;
}): Promise<TokenUnlockRow[]> {
  const now = Date.now();
  const wheres = ["unlock_at > ?"];
  const params: Array<string | number> = [now];
  if (opts?.withinMs != null) {
    wheres.push("unlock_at <= ?");
    params.push(now + opts.withinMs);
  }
  if (opts?.tradableOnly) {
    wheres.push("tradable_perp = 1 AND sodex_symbol IS NOT NULL AND asset_id IS NOT NULL");
  }
  let sql = `SELECT * FROM token_unlocks WHERE ${wheres.join(" AND ")} ORDER BY unlock_at ASC`;
  if (opts?.limit != null) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }
  return all<TokenUnlockRow>(sql, params);
}

/** Total USD unlocking within `withinMs` from now (tradable + non-tradable). */
export async function sumUpcomingUsd(withinMs: number): Promise<number> {
  const now = Date.now();
  const r = await get<{ total: number | null }>(
    `SELECT SUM(unlock_value_usd) AS total FROM token_unlocks
     WHERE unlock_at > ? AND unlock_at <= ?`,
    [now, now + withinMs],
  );
  return r?.total ?? 0;
}
