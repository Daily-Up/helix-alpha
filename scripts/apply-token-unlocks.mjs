#!/usr/bin/env node
/**
 * Apply the `token_unlocks` table + indexes to the prod Turso DB.
 *
 * The runtime schema bootstrap aborts at the bare `ALTER TABLE` statements
 * on an already-migrated prod DB, so new tables must be applied out-of-band.
 * This is idempotent (CREATE TABLE / INDEX IF NOT EXISTS) and safe to re-run.
 *
 * Run with:
 *   node --env-file=.env.local scripts/apply-token-unlocks.mjs
 */

import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.error("✗ TURSO_DATABASE_URL is not set");
  process.exit(1);
}

const DDL = `
CREATE TABLE IF NOT EXISTS token_unlocks (
  id                  TEXT PRIMARY KEY,
  protocol_slug       TEXT NOT NULL,
  token_id            TEXT,
  symbol              TEXT NOT NULL,
  asset_id            TEXT,
  sodex_symbol        TEXT,
  tradable_perp       INTEGER NOT NULL DEFAULT 0,
  unlock_at           INTEGER NOT NULL,
  unlock_date         TEXT NOT NULL,
  unlock_kind         TEXT,
  tokens_unlocked     REAL,
  unlock_value_usd    REAL,
  price_usd           REAL,
  pct_of_circulating  REAL,
  pct_of_max_supply   REAL,
  categories_json     TEXT,
  source              TEXT,
  raw_json            TEXT,
  ingested_at         INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_token_unlocks_at       ON token_unlocks(unlock_at);
CREATE INDEX IF NOT EXISTS idx_token_unlocks_tradable ON token_unlocks(tradable_perp, unlock_at);
CREATE INDEX IF NOT EXISTS idx_token_unlocks_asset    ON token_unlocks(asset_id, unlock_at);
`;

console.log(`→ connecting to ${url}`);
const client = createClient({ url, authToken });

try {
  await client.executeMultiple(DDL);
  const cols = await client.execute("PRAGMA table_info(token_unlocks)");
  console.log(`✓ token_unlocks ready — ${cols.rows.length} columns:`);
  for (const c of cols.rows) console.log(`   • ${c.name} ${c.type}`);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
} finally {
  client.close();
}
