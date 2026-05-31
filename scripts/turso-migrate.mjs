#!/usr/bin/env node
/**
 * One-shot migration from local better-sqlite3 (./data/sosoalpha.db) into
 * the configured Turso (libSQL) database.
 *
 * Strategy:
 *   1. Optionally wipe Turso (--reset).
 *   2. Apply src/lib/db/schema.sql to Turso. Strip FK clauses so loading
 *      order doesn't matter — the app layer doesn't depend on DB-enforced
 *      FKs; integrity is owned by the repo functions.
 *   3. Parallel-batch insert each table. ~200 rows per batch keeps under
 *      the 30 MB request cap; concurrency caps roundtrip latency.
 *   4. Verify row counts.
 *
 * Usage:
 *   node --env-file=.env.local scripts/turso-migrate.mjs            # additive
 *   node --env-file=.env.local scripts/turso-migrate.mjs --reset    # drop + reload
 */

import { createClient } from "@libsql/client";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const RESET = args.includes("--reset");
const CHUNK_SIZE = 200;
const CONCURRENCY = 4;
const LOCAL_DB_PATH = resolve(
  process.cwd(),
  process.env.DATABASE_PATH ?? "./data/sosoalpha.db",
);
const SCHEMA_PATH = resolve(process.cwd(), "src/lib/db/schema.sql");

if (!process.env.TURSO_DATABASE_URL) {
  console.error("✗ TURSO_DATABASE_URL is not set");
  process.exit(1);
}

console.log(`local:  ${LOCAL_DB_PATH}`);
console.log(`turso:  ${process.env.TURSO_DATABASE_URL}`);
console.log(`mode:   ${RESET ? "reset (drop + reload)" : "additive"}\n`);

const local = new Database(LOCAL_DB_PATH, { readonly: true });
const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ── Step 0 (optional): wipe Turso ────────────────────────────────────────
//
// Drops can fail when other tables FK-reference the target. We loop
// until no progress is made — each pass drops whatever's safe to drop
// now, eventually clearing the graph.
if (RESET) {
  console.log("→ dropping existing tables on Turso");
  let totalDropped = 0;
  for (let pass = 0; pass < 10; pass++) {
    const existing = await turso.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'",
    );
    if (existing.rows.length === 0) break;
    let droppedThisPass = 0;
    for (const row of existing.rows) {
      const name = row.name;
      try {
        await turso.execute(`DROP TABLE IF EXISTS "${name}"`);
        droppedThisPass++;
        totalDropped++;
      } catch (err) {
        // FK-blocked drops: defer to next pass.
        if (!/foreign key|constraint/i.test(err.message)) {
          console.warn(`  ⚠ ${name}: ${err.message}`);
        }
      }
    }
    if (droppedThisPass === 0) {
      console.warn(
        `  ⚠ stuck — ${existing.rows.length} table(s) couldn't be dropped on pass ${pass + 1}`,
      );
      break;
    }
  }
  console.log(`  ✓ dropped ${totalDropped} table(s)\n`);
}

// ── Step 1: schema (FK-stripped) ─────────────────────────────────────────
console.log("→ applying schema.sql to Turso (FK constraints stripped)");
let schemaSrc = readFileSync(SCHEMA_PATH, "utf8");

// Strip inline FKs:  `colname TYPE ... REFERENCES other(col) ON DELETE CASCADE`
// becomes           `colname TYPE ...`
schemaSrc = schemaSrc.replace(
  /\s+REFERENCES\s+\w+\s*\([^)]+\)(\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION))*/gi,
  "",
);

// Strip block-level FOREIGN KEY constraints inside CREATE TABLE.
schemaSrc = schemaSrc.replace(
  /,\s*FOREIGN\s+KEY\s*\([^)]+\)\s+REFERENCES\s+\w+\s*\([^)]+\)(\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION))*/gi,
  "",
);

try {
  await turso.executeMultiple(schemaSrc);
  console.log("  ✓ schema applied\n");
} catch (err) {
  console.error(`  ✗ schema apply failed: ${err.message}`);
  process.exit(1);
}

// ── Step 2: enumerate tables ─────────────────────────────────────────────
const tableRows = local
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  .all();
const tables = tableRows.map((r) => r.name);
console.log(`→ copying ${tables.length} table(s)\n`);

// ── Step 3: per-table parallel batch import ─────────────────────────────
const summary = [];
for (const table of tables) {
  const cols = local.prepare(`PRAGMA table_info(${table})`).all();
  const colNames = cols.map((c) => c.name);
  const rows = local.prepare(`SELECT * FROM ${table}`).all();

  if (rows.length === 0) {
    summary.push({ table, rows: 0, copied: 0 });
    console.log(`  ${table}: empty, skipping`);
    continue;
  }

  const placeholders = colNames.map(() => "?").join(", ");
  const sql = `INSERT OR REPLACE INTO ${table} (${colNames.join(", ")}) VALUES (${placeholders})`;
  const coerce = (v) => {
    if (v == null) return null;
    if (typeof v === "bigint") return Number(v);
    return v;
  };

  // Build the list of batches.
  const batches = [];
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    batches.push(
      rows.slice(i, i + CHUNK_SIZE).map((row) => ({
        sql,
        args: colNames.map((c) => coerce(row[c])),
      })),
    );
  }

  // Fire N batches in parallel; wait for each wave before starting next.
  let copied = 0;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const wave = batches.slice(i, i + CONCURRENCY);
    try {
      await Promise.all(wave.map((b) => turso.batch(b, "write")));
      copied += wave.reduce((n, b) => n + b.length, 0);
      process.stdout.write(`\r  ${table}: ${copied}/${rows.length}`);
    } catch (err) {
      console.log("");
      console.error(`  ✗ ${table}: ${err.message}`);
      summary.push({ table, rows: rows.length, copied, error: err.message });
      break;
    }
  }
  console.log("");
  if (!summary.find((s) => s.table === table)) {
    summary.push({ table, rows: rows.length, copied });
  }
}

// ── Step 4: verify ───────────────────────────────────────────────────────
console.log("\n→ verifying row counts");
for (const s of summary) {
  try {
    const check = await turso.execute(
      `SELECT COUNT(*) AS n FROM ${s.table}`,
    );
    s.copied = Number(check.rows[0].n);
  } catch {
    /* ignore */
  }
}

console.log("\n──────── summary ────────");
let allOk = true;
for (const s of summary) {
  const ok = s.copied >= s.rows;
  if (!ok) allOk = false;
  console.log(
    `  ${ok ? "✓" : "✗"} ${s.table.padEnd(34)} local=${String(s.rows).padStart(7)}  turso=${String(s.copied).padStart(7)}`,
  );
}
console.log(allOk ? "\n✓ migration complete" : "\n✗ row count mismatch");

local.close();
turso.close();
process.exit(allOk ? 0 : 1);
