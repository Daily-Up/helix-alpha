/**
 * I-45 invariant — every persisted signal carries a non-null
 * significance_score. Wave 2: async libSQL.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { get, run } from "../src/lib/db";
import * as Signals from "../src/lib/db/repos/signals";
import { setupMemoryDb, teardownMemoryDb } from "./db-setup";

beforeAll(async () => {
  await setupMemoryDb();
  await run(
    `INSERT OR IGNORE INTO assets
       (id, symbol, name, kind, tags, routing, rank, tradable)
     VALUES ('tok-btc', 'BTC', 'Bitcoin', 'token', '[]', '{}', 1, NULL)`,
  );
});
afterAll(() => teardownMemoryDb());

describe("I-45 — significance_score is mandatory on persisted signals", () => {
  it("inserts populate the significance_score column when caller supplies a value", async () => {
    const id = "inv-test-1";
    await Signals.insertSignal({
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
    const row = await Signals.getSignal(id);
    expect(row).toBeDefined();
    expect(row!.significance_score).toBe(0.42);
  });

  it("after backfill, no signal row carries NULL significance_score", async () => {
    await run(
      `UPDATE signals
         SET significance_score = 0
       WHERE significance_score IS NULL`,
    );
    const nullCount = await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM signals WHERE significance_score IS NULL`,
    );
    expect(nullCount?.n ?? -1).toBe(0);
  });
});
