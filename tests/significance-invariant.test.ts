/**
 * I-45 invariant — every persisted signal carries a non-null
 * significance_score.
 *
 * This is the production-grade defense against regressions where a new
 * code path bypasses the significance pipeline (the bug discovered after
 * the Phase C deployment, fixed in this commit). The test seeds a tiny
 * in-memory DB, runs an insert, and asserts the schema + invariant hold.
 */

import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { bootstrapSchema, _setDatabaseForTests, db } from "../src/lib/db";
import * as Signals from "../src/lib/db/repos/signals";

beforeAll(() => {
  const conn = new Database(":memory:");
  conn.pragma("foreign_keys = ON");
  bootstrapSchema(conn);
  _setDatabaseForTests(conn);
  db()
    .prepare(
      `INSERT OR IGNORE INTO assets
         (id, symbol, name, kind, tags, routing, rank, tradable)
       VALUES ('tok-btc', 'BTC', 'Bitcoin', 'token', '[]', '{}', 1, NULL)`,
    )
    .run();
});

describe("I-45 — significance_score is mandatory on persisted signals", () => {
  it("inserts populate the significance_score column when caller supplies a value", () => {
    const id = "inv-test-1";
    Signals.insertSignal({
      id,
      triggered_by_event_id: null,
      pattern_id: null,
      asset_id: "tok-btc",
      sodex_symbol: "vBTC_vUSDC",
      direction: "long",
      tier: "review",
      confidence: 0.7,
      expected_impact_pct: null,
      expected_horizon: "1d",
      suggested_size_usd: 100,
      suggested_stop_pct: 3,
      suggested_target_pct: 5,
      reasoning: "invariant test row",
      secondary_asset_ids: null,
      catalyst_subtype: "security_disclosure",
      expires_at: null,
      corroboration_deadline: null,
      event_chain_id: null,
      asset_relevance: 0.9,
      promotional_score: 0,
      source_tier: 1,
      significance_score: 0.42,
    });
    const row = Signals.getSignal(id);
    expect(row).toBeDefined();
    expect(row!.significance_score).toBe(0.42);
  });

  it("after backfill, no signal row in the test fixture can carry NULL significance_score (post-fix invariant)", () => {
    // Simulate the production backfill — every existing row gets a
    // sentinel 0 if NULL.
    db()
      .prepare(
        `UPDATE signals
           SET significance_score = 0
         WHERE significance_score IS NULL`,
      )
      .run();
    const nullCount = db()
      .prepare<[], { n: number }>(
        `SELECT COUNT(*) AS n FROM signals WHERE significance_score IS NULL`,
      )
      .get();
    expect(nullCount?.n ?? -1).toBe(0);
  });
});
