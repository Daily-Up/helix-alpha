/**
 * Vitest setup — runs once per worker before any test file imports.
 *
 * Sets harmless test values for env vars that the runtime env loader
 * (`src/lib/env.ts`) requires via `z.string().min(1)`. We never actually
 * call the SoSoValue or Anthropic APIs from tests; these placeholders
 * just satisfy the loader so module imports that touch `env.X` succeed.
 *
 * DATABASE_PATH is set to a path that no test should write to: integration
 * tests inject their own in-memory DB via `_setDatabaseForTests`. If a
 * test accidentally hits the real `db()` code path with this path, the
 * resulting file ends up in /tmp where it can be cleaned up safely.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SOSOVALUE_API_KEY ??= "test-soso-key";
process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
process.env.DATABASE_PATH ??= join(tmpdir(), "sosoalpha-test-fallback.db");
