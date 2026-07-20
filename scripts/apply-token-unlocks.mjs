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
  unlock_vs_volume    REAL,
  float_pct           REAL,
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

// Columns added after the table first shipped — applied idempotently so a
// prod table created by an earlier run picks them up (ALTER … ADD COLUMN
// has no IF NOT EXISTS in SQLite, so we tolerate "duplicate column").
const ADD_COLUMNS = [
  "ALTER TABLE token_unlocks ADD COLUMN unlock_vs_volume REAL",
  "ALTER TABLE token_unlocks ADD COLUMN float_pct REAL",
];

console.log(`→ connecting to ${url}`);
const client = createClient({ url, authToken });

try {
  await client.executeMultiple(DDL);
  for (const sql of ADD_COLUMNS) {
    try {
      await client.execute(sql);
      console.log(`  + ${sql.split("ADD COLUMN ")[1]}`);
    } catch (e) {
      if (/duplicate column/i.test(e.message)) {
        console.log(`  = ${sql.split("ADD COLUMN ")[1]} (already present)`);
      } else {
        throw e;
      }
    }
  }
  const cols = await client.execute("PRAGMA table_info(token_unlocks)");
  console.log(`✓ token_unlocks ready — ${cols.rows.length} columns:`);
  for (const c of cols.rows) console.log(`   • ${c.name} ${c.type}`);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
} finally {
  client.close();
}
