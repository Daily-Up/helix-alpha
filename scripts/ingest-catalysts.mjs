#!/usr/bin/env node
/**
 * Ingest the hand-curated catalyst CSV into `historical_catalysts`.
 *
 * Source: tmp_catalysts.csv produced by tmp_catalysts.mjs.
 * Columns: date,asset,category,headline,btc_close,btc_move_event_day,
 *          btc_move_1d,btc_move_3d,btc_move_7d,btc_move_30d,
 *          eth_close,eth_move_event_day,eth_move_1d,eth_move_3d,
 *          eth_move_7d,eth_move_30d,error
 *
 * ID generation: slug of date + first 8 words of headline, deduped with a
 * numeric suffix when two rows collide (e.g. multiple FOMC days). This
 * keeps re-runs idempotent.
 */

import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ─── CSV parser (handles quoted fields with commas inside) ──────────────────
function parseCsv(text) {
  const rows = [];
  let cur = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { inQuotes = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { cur.push(field); field = ""; i++; continue; }
    if (ch === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    field += ch; i++;
  }
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }
  return rows;
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function num(x) {
  if (x === "" || x === undefined || x === null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// ─── Main ───────────────────────────────────────────────────────────────────
const csvPath = resolve(process.cwd(), "tmp_catalysts.csv");
if (!existsSync(csvPath)) {
  console.error("tmp_catalysts.csv not found in cwd");
  process.exit(1);
}

const raw = readFileSync(csvPath, "utf8");
const rows = parseCsv(raw);
const header = rows[0];
const dataRows = rows.slice(1).filter((r) => r.length >= header.length && r[0]);

console.log(`Loaded ${dataRows.length} rows from tmp_catalysts.csv`);

const colIdx = Object.fromEntries(header.map((h, i) => [h, i]));
const need = ["date", "asset", "category", "headline"];
for (const k of need) {
  if (!(k in colIdx)) {
    console.error(`Missing column "${k}" in CSV`);
    process.exit(1);
  }
}

// ─── Build rows + dedup slug collisions ─────────────────────────────────────
const seenIds = new Set();
const records = [];
for (const r of dataRows) {
  const date = r[colIdx.date];
  const asset = r[colIdx.asset] || null;
  const category = r[colIdx.category];
  const headline = r[colIdx.headline];
  if (!date || !category || !headline) continue;

  // Use noon UTC so event_day moves anchor cleanly on the day in question.
  const ts_ms = Date.parse(`${date}T12:00:00Z`);
  if (Number.isNaN(ts_ms)) {
    console.warn(`  skip bad date: ${date}`);
    continue;
  }

  let base = `${date}-${slugify(headline)}`;
  let id = base;
  let n = 1;
  while (seenIds.has(id)) {
    n += 1;
    id = `${base}-${n}`;
  }
  seenIds.add(id);

  records.push({
    id,
    ts_ms,
    date,
    category,
    asset,
    description: headline,
    btc_move_event_day: num(r[colIdx.btc_move_event_day]),
    btc_move_1d: num(r[colIdx.btc_move_1d]),
    btc_move_3d: num(r[colIdx.btc_move_3d]),
    btc_move_7d: num(r[colIdx.btc_move_7d]),
    btc_move_30d: num(r[colIdx.btc_move_30d]),
    eth_move_event_day: num(r[colIdx.eth_move_event_day]),
    eth_move_1d: num(r[colIdx.eth_move_1d]),
    eth_move_3d: num(r[colIdx.eth_move_3d]),
    eth_move_7d: num(r[colIdx.eth_move_7d]),
    eth_move_30d: num(r[colIdx.eth_move_30d]),
  });
}

console.log(`Prepared ${records.length} records  (${dataRows.length - records.length} skipped)`);

// ─── Upsert ─────────────────────────────────────────────────────────────────
const upsertSql = `INSERT INTO historical_catalysts (
  id, ts_ms, date, category, asset, description,
  btc_move_event_day, btc_move_1d, btc_move_3d, btc_move_7d, btc_move_30d,
  eth_move_event_day, eth_move_1d, eth_move_3d, eth_move_7d, eth_move_30d
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  ts_ms = excluded.ts_ms,
  date  = excluded.date,
  category = excluded.category,
  asset = excluded.asset,
  description = excluded.description,
  btc_move_event_day = excluded.btc_move_event_day,
  btc_move_1d = excluded.btc_move_1d,
  btc_move_3d = excluded.btc_move_3d,
  btc_move_7d = excluded.btc_move_7d,
  btc_move_30d = excluded.btc_move_30d,
  eth_move_event_day = excluded.eth_move_event_day,
  eth_move_1d = excluded.eth_move_1d,
  eth_move_3d = excluded.eth_move_3d,
  eth_move_7d = excluded.eth_move_7d,
  eth_move_30d = excluded.eth_move_30d
`;

const BATCH = 100;
let upserted = 0;
for (let i = 0; i < records.length; i += BATCH) {
  const slice = records.slice(i, i + BATCH);
  await db.batch(
    slice.map((r) => ({
      sql: upsertSql,
      args: [
        r.id, r.ts_ms, r.date, r.category, r.asset, r.description,
        r.btc_move_event_day, r.btc_move_1d, r.btc_move_3d, r.btc_move_7d, r.btc_move_30d,
        r.eth_move_event_day, r.eth_move_1d, r.eth_move_3d, r.eth_move_7d, r.eth_move_30d,
      ],
    })),
    "write",
  );
  upserted += slice.length;
  process.stdout.write(`  upserted ${upserted}/${records.length}\r`);
}

console.log(`\nDONE — ${upserted} rows`);

// ─── Verify per-category counts ─────────────────────────────────────────────
const v = await db.execute({
  sql: `SELECT category, COUNT(*) AS n,
               AVG(btc_move_event_day) AS avg_btc,
               MIN(btc_move_event_day) AS min_btc,
               MAX(btc_move_event_day) AS max_btc
        FROM historical_catalysts
        GROUP BY category
        ORDER BY n DESC`,
});
console.log("\nCategory distribution:");
for (const row of v.rows) {
  const avg = row.avg_btc == null ? "  --" : `${Number(row.avg_btc).toFixed(2)}%`;
  const min = row.min_btc == null ? "  --" : `${Number(row.min_btc).toFixed(2)}%`;
  const max = row.max_btc == null ? "  --" : `${Number(row.max_btc).toFixed(2)}%`;
  console.log(`  ${String(row.category).padEnd(26)} ${String(row.n).padStart(4)}   avg=${avg.padStart(7)}   min=${min.padStart(7)}   max=${max.padStart(7)}`);
}

process.exit(0);
