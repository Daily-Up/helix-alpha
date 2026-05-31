#!/usr/bin/env node
/**
 * Sanity-check the Turso connection: reads env, opens a libSQL client,
 * runs `SELECT 1` and `SELECT name FROM sqlite_master`. Prints any rows
 * and exits 0 on success, 1 on failure.
 *
 * Run with:
 *   node --env-file=.env.local scripts/turso-ping.mjs
 */

import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.error("✗ TURSO_DATABASE_URL is not set");
  process.exit(1);
}

console.log(`→ connecting to ${url}`);
const client = createClient({ url, authToken });

try {
  const ping = await client.execute("SELECT 1 AS ok");
  console.log(`✓ SELECT 1 → ${JSON.stringify(ping.rows[0])}`);

  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  );
  console.log(`✓ ${tables.rows.length} table(s) in DB:`);
  for (const row of tables.rows) console.log(`   • ${row.name}`);
  if (tables.rows.length === 0) {
    console.log("   (none — schema not bootstrapped yet)");
  }
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
} finally {
  client.close();
}
