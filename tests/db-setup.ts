/**
 * libSQL :memory: test helper — replaces the Wave 1 better-sqlite3
 * `_setDatabaseForTests(memDb)` pattern.
 *
 * Usage:
 *   beforeEach(async () => {
 *     await setupMemoryDb();
 *   });
 *   afterEach(() => teardownMemoryDb());
 *
 * Each test gets a fresh libSQL `:memory:` client with the production
 * schema applied. Tests should use the async repo APIs and the
 * `all`/`get`/`run` helpers exactly as production does.
 */

import { createClient, type Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { _setClientForTests, closeDb } from "@/lib/db/client";

let _mem: Client | null = null;

export async function setupMemoryDb(): Promise<Client> {
  if (_mem) {
    teardownMemoryDb();
  }
  // Per-test isolated in-memory DB. cache=shared would persist state
  // between tests via the SQLite shared-cache; we want a fresh DB each
  // beforeEach.
  _mem = createClient({ url: ":memory:" });
  const schemaSrc = readFileSync(
    resolve(process.cwd(), "src/lib/db/schema.sql"),
    "utf8",
  );
  await _mem.executeMultiple(schemaSrc);
  _setClientForTests(_mem);
  return _mem;
}

export function teardownMemoryDb(): void {
  if (_mem) {
    try {
      _mem.close();
    } catch {
      /* ignore */
    }
    _mem = null;
  }
  closeDb();
  _setClientForTests(null);
}

/** Convenience for tests that want the raw client to seed manually. */
export function memDb(): Client {
  if (!_mem) throw new Error("call setupMemoryDb() first");
  return _mem;
}
