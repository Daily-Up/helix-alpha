/**
 * Database connection — synchronous SQLite via better-sqlite3.
 *
 * better-sqlite3 is process-local and synchronous: perfect for Next.js API
 * routes (one DB call ≈ 1-3ms) and CLI scripts. For Vercel deployment we'll
 * swap this for libSQL/Turso behind the same query API; the call sites
 * never see the underlying driver.
 *
 * Connection lifecycle:
 *   • Lazy: created on first call to `db()`
 *   • Process-singleton: re-used across all requests in the same Node process
 *   • WAL mode: better concurrency for the cron + UI reads
 *   • foreign_keys: ON (FK constraints don't fire by default in SQLite!)
 */

import Database from "better-sqlite3";
import { mkdirSync, existsSync, readFileSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env } from "@/lib/env";

let _db: Database.Database | null = null;
let _hydrated = false;

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Vercel-compatibility shim.
 *
 * Vercel's serverless filesystem is read-only except for `/tmp`. On cold
 * start we copy the bundled production snapshot (`data/sosoalpha.db`,
 * checked in for the buildathon demo) to the writable `/tmp` location
 * pointed at by `DATABASE_PATH`. Writes during the function's lifetime
 * persist there; they reset on the next cold start. Live ingest still
 * fires inside the instance, judges interact with a feels-live dashboard,
 * but the state is per-instance.
 *
 * Local dev path is untouched — `DATABASE_PATH=./data/sosoalpha.db`
 * keeps everything in-tree as before.
 *
 * Migration to a hosted DB (Turso / Vercel Postgres) is the follow-up
 * after the buildathon; this lets us ship now without an async rewrite.
 */
function hydrateFromSnapshotIfNeeded(targetPath: string): void {
  if (_hydrated) return;
  _hydrated = true;
  // Only fire when DATABASE_PATH lives under /tmp — that's the Vercel
  // production setting. Local dev (./data/sosoalpha.db) skips this.
  const isTmpTarget =
    targetPath.startsWith("/tmp/") || targetPath.startsWith("\\tmp\\");
  if (!isTmpTarget) return;
  // If the /tmp copy already exists (warm instance), nothing to do.
  if (existsSync(targetPath)) return;
  // Find the bundled snapshot. The deployment ships `data/sosoalpha.db`
  // alongside the source.
  const snapshot = resolve(process.cwd(), "data/sosoalpha.db");
  if (!existsSync(snapshot)) {
    console.warn(
      `[db] no snapshot at ${snapshot} — production DB will be empty`,
    );
    return;
  }
  ensureDir(targetPath);
  copyFileSync(snapshot, targetPath);
  console.log(`[db] hydrated ${targetPath} from snapshot (${snapshot})`);
}

/**
 * Run schema.sql against the provided connection. Used by `db()` on the
 * production path and by integration tests to bootstrap an in-memory
 * `:memory:` connection without going through the env-loader / file-
 * path code path.
 *
 * Pure: takes the conn in, no module-level state, no env access.
 * Idempotent: every CREATE in schema.sql uses IF NOT EXISTS.
 *
 * For a fresh in-memory DB this is sufficient. The tiny migrations in
 * `db()` only kick in for existing dev databases that pre-date a schema
 * change; a from-scratch :memory: DB doesn't need them.
 */
export function bootstrapSchema(conn: Database.Database): void {
  const schemaPath = resolve(__dirname, "schema.sql");
  const schemaSrc = existsSync(schemaPath)
    ? readFileSync(schemaPath, "utf8")
    : readFileSync(
        resolve(process.cwd(), "src/lib/db/schema.sql"),
        "utf8",
      );
  conn.exec(schemaSrc);
}

/**
 * Inject a pre-built connection as the singleton. Test-only seam: lets
 * integration tests build an in-memory `new Database(':memory:')`, run
 * `bootstrapSchema` on it, then make `db()` return that instance.
 *
 * Closes any existing singleton first so callers don't leak handles
 * across test cases. NOT meant for production use.
 */
export function _setDatabaseForTests(conn: Database.Database | null): void {
  if (_db && _db !== conn) _db.close();
  _db = conn;
}

/** Get the singleton DB connection. Creates + bootstraps schema on first call. */
export function db(): Database.Database {
  if (_db) return _db;

  const path = resolve(process.cwd(), env.DATABASE_PATH);
  // Vercel cold start: copy the bundled snapshot to /tmp first time.
  hydrateFromSnapshotIfNeeded(path);
  ensureDir(path);

  const conn = new Database(path);
  // WAL journal needs persistent storage; Vercel's /tmp survives within
  // a single invocation but the journal-vs-main split can corrupt on
  // suspend. Use the simpler DELETE journal in tmp deployments.
  const isTmpTarget =
    path.startsWith("/tmp/") || path.startsWith("\\tmp\\");
  conn.pragma(isTmpTarget ? "journal_mode = DELETE" : "journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.pragma("synchronous = NORMAL");

  // Bootstrap schema. Idempotent — every CREATE uses IF NOT EXISTS.
  const schemaPath = resolve(__dirname, "schema.sql");
  // In bundled Next.js builds __dirname might not resolve to the source —
  // fall back to project-relative path.
  const schemaSrc = existsSync(schemaPath)
    ? readFileSync(schemaPath, "utf8")
    : readFileSync(
        resolve(process.cwd(), "src/lib/db/schema.sql"),
        "utf8",
      );

  // Tiny migration #1: if `impact_metrics` has the old (1h/4h/24h) schema,
  // drop it so schema.sql recreates with the new (1d/3d/7d) columns.
  try {
    type ColRow = { name: string };
    const cols = conn
      .prepare<[], ColRow>("PRAGMA table_info(impact_metrics)")
      .all();
    const hasNew = cols.some((c) => c.name === "impact_pct_1d");
    if (cols.length > 0 && !hasNew) {
      conn.exec("DROP TABLE impact_metrics");
    }
  } catch {
    /* table missing — fine */
  }

  // Tiny migration #2: add `tradable` column to assets if missing.
  try {
    type ColRow = { name: string };
    const cols = conn
      .prepare<[], ColRow>("PRAGMA table_info(assets)")
      .all();
    const hasTradable = cols.some((c) => c.name === "tradable");
    if (cols.length > 0 && !hasTradable) {
      conn.exec("ALTER TABLE assets ADD COLUMN tradable TEXT");
    }
  } catch {
    /* table missing — fine, schema.sql will create it */
  }

  // Tiny migration #3: drop old signals/paper_trades if they lack the new
  // tier-based columns. Both are empty in dev, so safe to recreate.
  try {
    type ColRow = { name: string };
    const sigCols = conn
      .prepare<[], ColRow>("PRAGMA table_info(signals)")
      .all();
    if (sigCols.length > 0 && !sigCols.some((c) => c.name === "tier")) {
      conn.exec("DROP TABLE signals");
    }
    const ptCols = conn
      .prepare<[], ColRow>("PRAGMA table_info(paper_trades)")
      .all();
    if (
      ptCols.length > 0 &&
      !ptCols.some((c) => c.name === "sodex_symbol")
    ) {
      conn.exec("DROP TABLE paper_trades");
    }
  } catch {
    /* missing tables — schema.sql will create them */
  }

  // Tiny migration #8: add secondary_asset_ids to signals so we can
  // record "also affected" assets for UI display while still firing
  // only ONE signal per event (the primary asset).
  try {
    type ColRow = { name: string };
    const cols = conn
      .prepare<[], ColRow>("PRAGMA table_info(signals)")
      .all();
    if (cols.length > 0 && !cols.some((c) => c.name === "secondary_asset_ids")) {
      conn.exec("ALTER TABLE signals ADD COLUMN secondary_asset_ids TEXT");
    }
  } catch {
    /* table missing — schema.sql will create it with the column */
  }

  // Tiny migration #9: add pipeline-metadata columns to signals so that
  // src/lib/pipeline/* modules can persist their derived fields. All
  // nullable so legacy rows pre-pipeline-wiring keep working.
  try {
    type ColRow = { name: string };
    const cols = conn
      .prepare<[], ColRow>("PRAGMA table_info(signals)")
      .all();
    if (cols.length > 0) {
      const has = (n: string) => cols.some((c) => c.name === n);
      if (!has("catalyst_subtype"))
        conn.exec("ALTER TABLE signals ADD COLUMN catalyst_subtype TEXT");
      if (!has("expires_at"))
        conn.exec("ALTER TABLE signals ADD COLUMN expires_at INTEGER");
      if (!has("corroboration_deadline"))
        conn.exec("ALTER TABLE signals ADD COLUMN corroboration_deadline INTEGER");
      if (!has("event_chain_id"))
        conn.exec("ALTER TABLE signals ADD COLUMN event_chain_id TEXT");
      if (!has("asset_relevance"))
        conn.exec("ALTER TABLE signals ADD COLUMN asset_relevance REAL");
      if (!has("promotional_score"))
        conn.exec("ALTER TABLE signals ADD COLUMN promotional_score REAL");
      if (!has("source_tier"))
        conn.exec("ALTER TABLE signals ADD COLUMN source_tier INTEGER");
      if (!has("dismiss_reason"))
        conn.exec("ALTER TABLE signals ADD COLUMN dismiss_reason TEXT");
      // Phase C/D/E columns.
      if (!has("significance_score"))
        conn.exec("ALTER TABLE signals ADD COLUMN significance_score REAL");
      if (!has("superseded_by_signal_id"))
        conn.exec(
          "ALTER TABLE signals ADD COLUMN superseded_by_signal_id TEXT",
        );
      if (!has("effective_end_at"))
        conn.exec("ALTER TABLE signals ADD COLUMN effective_end_at INTEGER");
      conn.exec(
        "CREATE INDEX IF NOT EXISTS idx_signals_expires_at ON signals(expires_at) WHERE expires_at IS NOT NULL",
      );
      conn.exec(
        "CREATE INDEX IF NOT EXISTS idx_signals_event_chain ON signals(event_chain_id) WHERE event_chain_id IS NOT NULL",
      );
    }
  } catch {
    /* table missing — schema.sql will create it correctly */
  }

  // Tiny migration #v2: add framework_version to index_rebalances so v2
  // rebalances can be distinguished from v1. Existing rows default to 'v1'.
  try {
    type ColRow = { name: string };
    const cols = conn
      .prepare<[], ColRow>("PRAGMA table_info(index_rebalances)")
      .all();
    if (cols.length > 0 && !cols.some((c) => c.name === "framework_version")) {
      conn.exec(
        "ALTER TABLE index_rebalances ADD COLUMN framework_version TEXT NOT NULL DEFAULT 'v1'",
      );
    }
  } catch {
    /* table missing — schema.sql will create it with the column */
  }

  // Tiny migration #v2-attribution: add framework_version to
  // signal_outcomes so calibration queries can split outcomes by
  // framework. Existing rows are tagged 'v1' (the framework active
  // before v2.1 graduated).
  try {
    type ColRow = { name: string };
    const cols = conn
      .prepare<[], ColRow>("PRAGMA table_info(signal_outcomes)")
      .all();
    if (cols.length > 0 && !cols.some((c) => c.name === "framework_version")) {
      conn.exec(
        "ALTER TABLE signal_outcomes ADD COLUMN framework_version TEXT NOT NULL DEFAULT 'v1'",
      );
      conn.exec(
        "CREATE INDEX IF NOT EXISTS idx_outcomes_framework ON signal_outcomes(framework_version, generated_at DESC)",
      );
    }
  } catch {
    /* table missing — schema.sql creates it with the column */
  }

  // Tiny migration #7: extend macro_history with raw + unit + surprise
  // columns so we can store the API's string-with-unit form alongside
  // parsed numbers. The original schema had only REAL columns which
  // silently lost units like "%".
  try {
    type ColRow = { name: string };
    const cols = conn
      .prepare<[], ColRow>("PRAGMA table_info(macro_history)")
      .all();
    if (cols.length > 0) {
      const has = (n: string) => cols.some((c) => c.name === n);
      if (!has("actual_raw"))
        conn.exec("ALTER TABLE macro_history ADD COLUMN actual_raw TEXT");
      if (!has("forecast_raw"))
        conn.exec("ALTER TABLE macro_history ADD COLUMN forecast_raw TEXT");
      if (!has("previous_raw"))
        conn.exec("ALTER TABLE macro_history ADD COLUMN previous_raw TEXT");
      if (!has("unit"))
        conn.exec("ALTER TABLE macro_history ADD COLUMN unit TEXT");
      if (!has("surprise"))
        conn.exec("ALTER TABLE macro_history ADD COLUMN surprise REAL");
      // Indexes are CREATE IF NOT EXISTS so safe to run repeatedly.
      conn.exec(
        "CREATE INDEX IF NOT EXISTS idx_macro_history_date ON macro_history(date DESC)",
      );
      conn.exec(
        "CREATE INDEX IF NOT EXISTS idx_macro_history_event_date ON macro_history(event, date DESC)",
      );
    }
  } catch {
    /* table missing — schema.sql will create it correctly */
  }

  // Tiny migration #6: add duplicate_of column to news_events for content-
  // level dedup of news from multiple outlets covering the same story.
  try {
    type ColRow = { name: string };
    const cols = conn
      .prepare<[], ColRow>("PRAGMA table_info(news_events)")
      .all();
    if (cols.length > 0 && !cols.some((c) => c.name === "duplicate_of")) {
      conn.exec("ALTER TABLE news_events ADD COLUMN duplicate_of TEXT");
      conn.exec(
        "CREATE INDEX IF NOT EXISTS idx_news_dup_of ON news_events(duplicate_of)",
      );
    }
  } catch {
    /* table missing — schema.sql will create it with the column */
  }

  // Tiny migration #5: add rationale column to index_positions if missing.
  // Existing rows keep NULL until next rebalance writes their reasoning.
  try {
    type ColRow = { name: string };
    const cols = conn
      .prepare<[], ColRow>("PRAGMA table_info(index_positions)")
      .all();
    if (cols.length > 0 && !cols.some((c) => c.name === "rationale")) {
      conn.exec("ALTER TABLE index_positions ADD COLUMN rationale TEXT");
    }
  } catch {
    /* table missing — schema.sql will create it with the column */
  }

  // Tiny migration #4: add actionable + event_recency to classifications
  // if missing. Existing rows keep NULL until re-classified.
  try {
    type ColRow = { name: string };
    const cols = conn
      .prepare<[], ColRow>("PRAGMA table_info(classifications)")
      .all();
    if (cols.length > 0) {
      if (!cols.some((c) => c.name === "actionable")) {
        conn.exec("ALTER TABLE classifications ADD COLUMN actionable INTEGER");
      }
      if (!cols.some((c) => c.name === "event_recency")) {
        conn.exec(
          "ALTER TABLE classifications ADD COLUMN event_recency TEXT",
        );
      }
    }
  } catch {
    /* table missing — schema.sql creates it with these columns */
  }

  // Tiny migration #11: Part 1 tables (signal_outcomes, system_alerts).
  // schema.exec below runs the CREATE TABLE IF NOT EXISTS for new tables;
  // we don't need ALTERs here because the table didn't exist before.
  // Documented for future devs who grep the migrations list.

  // Tiny migration #10: Dimensions 1/3 columns on classifications.
  // - embedding: JSON-serialized number[] for semantic freshness check
  // - coverage_continuation_of: link to prior event when 0.42 ≤ sim < 0.55
  // - mechanism_length / mechanism_reasoning: D3 reasoning chain length
  // - counterfactual_strength / counterfactual_reasoning: D3 counterargument
  try {
    type ColRow = { name: string };
    const cols = conn
      .prepare<[], ColRow>("PRAGMA table_info(classifications)")
      .all();
    if (cols.length > 0) {
      const has = (n: string) => cols.some((c) => c.name === n);
      if (!has("embedding"))
        conn.exec("ALTER TABLE classifications ADD COLUMN embedding TEXT");
      if (!has("coverage_continuation_of"))
        conn.exec(
          "ALTER TABLE classifications ADD COLUMN coverage_continuation_of TEXT",
        );
      if (!has("mechanism_length"))
        conn.exec(
          "ALTER TABLE classifications ADD COLUMN mechanism_length INTEGER",
        );
      if (!has("mechanism_reasoning"))
        conn.exec(
          "ALTER TABLE classifications ADD COLUMN mechanism_reasoning TEXT",
        );
      if (!has("counterfactual_strength"))
        conn.exec(
          "ALTER TABLE classifications ADD COLUMN counterfactual_strength TEXT",
        );
      if (!has("counterfactual_reasoning"))
        conn.exec(
          "ALTER TABLE classifications ADD COLUMN counterfactual_reasoning TEXT",
        );
    }
  } catch {
    /* table missing — schema.sql creates it with these columns */
  }

  conn.exec(schemaSrc);

  _db = conn;
  return _db;
}

/** Close the connection (mainly for tests). */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Run a function inside a transaction. Returns whatever the function returns.
 * Throws → rollback. Useful for ingest pipelines that touch multiple tables.
 */
export function transaction<T>(fn: (db: Database.Database) => T): T {
  const conn = db();
  return conn.transaction(fn)(conn);
}
