/**
 * Database connection — async libSQL/Turso client.
 *
 * Wave 1 ran on better-sqlite3 + a /tmp snapshot on Vercel. That worked
 * for the demo but the data was ephemeral: every cold start wiped
 * recently-ingested events. Wave 2 swaps the driver for `@libsql/client`,
 * which talks to a hosted libSQL database (Turso). Writes persist across
 * deploys; reads survive cold starts; localhost and production can point
 * at the same DB (or separate ones — see env).
 *
 * The migration is mechanical at the call sites: every repo function
 * becomes async, and the SQL goes through `execute()` instead of
 * `.prepare().run()`. The helpers below (`all`, `get`, `run`, `batch`)
 * keep repo files concise.
 *
 * Connection lifecycle:
 *   • Lazy: client created on first call to `getClient()`
 *   • Process-singleton: one client per Node process; libSQL pools internally
 *   • Schema bootstrap: runs schema.sql once per process startup
 */

import {
  createClient,
  type Client,
  type InArgs,
  type InStatement,
  type ResultSet,
} from "@libsql/client";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

let _client: Client | null = null;
let _schemaBootstrapped = false;

/**
 * Get the singleton libSQL client. Reads connection details from env on
 * first invocation. Throws if TURSO_DATABASE_URL is missing — we never
 * want to silently fall back to a local file in production.
 */
export function getClient(): Client {
  if (_client) return _client;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TURSO_DATABASE_URL is not set. Configure Turso credentials in .env.local " +
        "(dev) or Vercel project env (production).",
    );
  }
  _client = createClient({
    url,
    // Auth token is optional for local `file:` URLs but required for the
    // remote libsql:// scheme. The libSQL client tolerates undefined.
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  return _client;
}

/**
 * Inject a pre-built client as the singleton. Test-only seam: lets
 * integration tests build an in-memory client with `createClient({ url:
 * "file::memory:" })`, bootstrap the schema on it, then make
 * `getClient()` return that instance.
 */
export function _setClientForTests(client: Client | null): void {
  if (_client && _client !== client) {
    try {
      _client.close();
    } catch {
      /* ignore */
    }
  }
  _client = client;
  _schemaBootstrapped = false;
}

/** Close the connection (mainly for tests). */
export function closeDb(): void {
  if (_client) {
    try {
      _client.close();
    } catch {
      /* ignore */
    }
    _client = null;
  }
  _schemaBootstrapped = false;
}

/**
 * Split a SQL script into individual statements on top-level `;`, ignoring
 * semicolons that live inside line comments (`-- …`), block comments or
 * string / identifier literals (`'…'`, `"…"`). schema.sql has no triggers or
 * BEGIN…END blocks, so a top-level `;` always ends a statement — but it is
 * full of comments and string literals that contain semicolons (e.g.
 * `-- Helix asset id ("tok-arb"); NULL if not in universe`), so a plain
 * `split(";")` would shred real statements. Comments are dropped (replaced by
 * whitespace); literals are copied through verbatim.
 */
function splitSqlStatements(src: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    // Line comment → drop to end of line, preserving the newline.
    if (ch === "-" && next === "-") {
      const eol = src.indexOf("\n", i);
      i = eol === -1 ? n : eol;
      cur += "\n";
      continue;
    }
    // Block comment (covers both /* and /**) → drop, leave a space behind.
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      cur += " ";
      continue;
    }
    // String literal or quoted identifier → copy verbatim, honouring the
    // SQL doubled-quote escape ('' and "").
    if (ch === "'" || ch === '"') {
      const q = ch;
      cur += ch;
      i++;
      while (i < n) {
        if (src[i] === q) {
          if (src[i + 1] === q) {
            cur += q + q;
            i += 2;
            continue;
          }
          cur += q;
          i++;
          break;
        }
        cur += src[i];
        i++;
      }
      continue;
    }
    // Top-level statement terminator.
    if (ch === ";") {
      const t = cur.trim();
      if (t.length > 0) out.push(t);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  const tail = cur.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/**
 * Apply schema.sql against the given client. Idempotent and resilient: every
 * statement runs on its own, so one failure can't block the rest. Used by
 * tests building an in-memory client; production runs the schema once via
 * `ensureSchema()` below on first DB call.
 */
export async function bootstrapSchema(client: Client): Promise<void> {
  const schemaPath = resolve(process.cwd(), "src/lib/db/schema.sql");
  if (!existsSync(schemaPath)) {
    throw new Error(`schema.sql not found at ${schemaPath}`);
  }
  const schemaSrc = readFileSync(schemaPath, "utf8");
  // Run every statement INDEPENDENTLY so one failure can't block the rest.
  // We used to call executeMultiple(), which runs the whole script as a single
  // unit — so one error aborted the script and silently skipped every table
  // after it. The classic trigger: `ALTER TABLE … ADD COLUMN` (SQLite has no
  // "ADD COLUMN IF NOT EXISTS") throwing "duplicate column name" on an
  // already-migrated DB, which used to skip macro_calibration, schema_version
  // and equity_snapshots. CREATEs are already `IF NOT EXISTS`; the
  // non-idempotent ADD COLUMNs throw a benign "duplicate column" we swallow.
  const statements = splitSqlStatements(schemaSrc);
  for (const sql of statements) {
    try {
      await client.execute(sql);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      // Benign on a DB that already has this table/column — that's the whole
      // point of an idempotent bootstrap. Anything else is worth surfacing,
      // but it still must not stop the remaining statements.
      if (/duplicate column name|already exists/i.test(msg)) continue;
      console.warn(`[db] schema statement skipped: ${msg}`);
    }
  }
}

/**
 * Lazily ensure the schema is in place. Called from helpers below before
 * the first query of a process. In production this is a no-op after the
 * first run — Turso retains the schema across deploys.
 */
async function ensureSchema(): Promise<void> {
  if (_schemaBootstrapped) return;
  _schemaBootstrapped = true;
  if (process.env.SKIP_SCHEMA_BOOTSTRAP === "1") return;
  try {
    await bootstrapSchema(getClient());
  } catch (err) {
    // Don't crash callers on schema bootstrap errors — Turso may already
    // have a stricter schema than our IF NOT EXISTS allows. Log and move
    // on; explicit migration files are the right fix.
    console.warn(
      `[db] schema bootstrap warning: ${(err as Error).message}`,
    );
  }
}

// ─── Async query helpers ─────────────────────────────────────────────
//
// Repos use these instead of raw `client.execute()` calls. Keeps the
// per-repo code at roughly the same line count as before.

/** Run a SQL statement that returns rows. */
export async function all<T = Record<string, unknown>>(
  sql: string,
  args?: InArgs,
): Promise<T[]> {
  await ensureSchema();
  const res = await getClient().execute({ sql, args: args ?? [] });
  return res.rows as unknown as T[];
}

/** Run a SQL statement that returns at most one row. */
export async function get<T = Record<string, unknown>>(
  sql: string,
  args?: InArgs,
): Promise<T | undefined> {
  await ensureSchema();
  const res = await getClient().execute({ sql, args: args ?? [] });
  return (res.rows[0] as unknown as T) ?? undefined;
}

/** Run a SQL statement that writes; returns the ResultSet for affected-row counts. */
export async function run(sql: string, args?: InArgs): Promise<ResultSet> {
  await ensureSchema();
  return getClient().execute({ sql, args: args ?? [] });
}

/**
 * Run a sequence of statements atomically. Either all commit or none do.
 * Use for ingest pipelines that touch multiple tables.
 *
 * Each statement can be a string (no args) or `{sql, args}`.
 */
export async function batch(statements: InStatement[]): Promise<ResultSet[]> {
  await ensureSchema();
  return getClient().batch(statements);
}

/**
 * Run a function inside an interactive transaction.
 * Returns whatever the function returns. Throws → rollback.
 *
 * Use for tx logic that needs to read between writes (e.g. upsert that
 * inspects an existing row first). For pure write sequences, prefer
 * `batch()` which is cheaper.
 */
export async function transaction<T>(
  fn: (tx: Awaited<ReturnType<Client["transaction"]>>) => Promise<T>,
  mode: "write" | "read" | "deferred" = "write",
): Promise<T> {
  await ensureSchema();
  const tx = await getClient().transaction(mode);
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      /* ignore rollback errors */
    }
    throw err;
  }
}

// ─── Back-compat shim ─────────────────────────────────────────────────
//
// Some files still import `db` from "../client" (Wave 1 sync style).
// During the async migration we expose `db()` returning the libSQL
// client itself; callers that used `.prepare().run()` will fail loudly
// rather than silently swallow data. The helpers above are the new path.

/** @deprecated — use `getClient()` or the async helpers (all/get/run/batch). */
export function db(): Client {
  return getClient();
}
