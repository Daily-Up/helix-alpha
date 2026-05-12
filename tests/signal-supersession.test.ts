/**
 * Live supersession tests (Phase E, I-43).
 *
 * Covers:
 *   - significance ratio threshold (≥ 1.5× → supersede, < 1.5× → suppress)
 *   - audit-trail row content (signal_supersessions)
 *   - terminal-state guarantee (superseded signals are excluded from
 *     subsequent conflict lookups; cannot be re-superseded)
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  resolveConflict,
  type ConflictCandidate,
} from "../src/lib/calibration/conflicts";
import {
  bootstrapSchema,
  _setDatabaseForTests,
  db,
} from "../src/lib/db";
import * as Signals from "../src/lib/db/repos/signals";
import {
  insertSupersession,
  getSupersessionForOld,
  listSupersessionsByNew,
} from "../src/lib/db/repos/conflicts";

function cand(over: Partial<ConflictCandidate>): ConflictCandidate {
  return {
    id: "default",
    direction: "long",
    asset_id: "tok-btc",
    start_at: 1_700_000_000_000,
    expires_at: 1_700_000_000_000 + 24 * 60 * 60 * 1000,
    asset_relevance: 0.9,
    significance_score: 0.5,
    conviction: 0.7,
    ...over,
  };
}

beforeAll(() => {
  const conn = new Database(":memory:");
  conn.pragma("foreign_keys = ON");
  bootstrapSchema(conn);
  _setDatabaseForTests(conn);
  // Seed a single asset so the signals FK resolves for our test rows.
  db()
    .prepare(
      `INSERT OR IGNORE INTO assets
         (id, symbol, name, kind, tags, routing, rank, tradable)
       VALUES ('tok-btc', 'BTC', 'Bitcoin', 'token', '[]', '{}', 1, NULL)`,
    )
    .run();
});

beforeEach(() => {
  db().exec("DELETE FROM signal_supersessions");
  db().exec("DELETE FROM signals WHERE id LIKE 'sup-test-%'");
});

describe("live supersession (Phase E, I-43)", () => {
  it("ratio ≥ 1.5× fires supersession verdict", () => {
    const existing = cand({
      id: "ex-1",
      direction: "long",
      significance_score: 0.5,
    });
    const newCand = cand({
      id: "new-1",
      direction: "short",
      significance_score: 0.8, // ratio 1.6
    });
    const verdict = resolveConflict(newCand, existing);
    expect(verdict.kind).toBe("supersede_existing");
    if (verdict.kind === "supersede_existing") {
      expect(verdict.ratio).toBeGreaterThanOrEqual(1.5);
      expect(verdict.reason).toMatch(/1\.5/);
    }
  });

  it("ratio < 1.5× does NOT supersede — falls back to suppress_existing", () => {
    const existing = cand({
      id: "ex-1",
      direction: "long",
      significance_score: 0.5,
    });
    const newCand = cand({
      id: "new-1",
      direction: "short",
      significance_score: 0.7, // ratio 1.4
    });
    const verdict = resolveConflict(newCand, existing);
    expect(verdict.kind).toBe("suppress_existing");
  });

  it("inserts a signal_supersessions row with ratio + reason", () => {
    const oldId = "sup-test-old-" + randomUUID();
    const newId = "sup-test-new-" + randomUUID();
    // Seed the two signals so the FK references resolve.
    seedSignal(oldId, { status: "superseded" });
    seedSignal(newId, { status: "pending" });
    insertSupersession({
      superseded_signal_id: oldId,
      superseding_signal_id: newId,
      significance_ratio: 1.7,
      reason: "test supersession",
    });
    const row = getSupersessionForOld(oldId);
    expect(row).toBeDefined();
    expect(row!.significance_ratio).toBe(1.7);
    expect(row!.reason).toBe("test supersession");

    const byNew = listSupersessionsByNew(newId);
    expect(byNew).toHaveLength(1);
    expect(byNew[0].superseded_signal_id).toBe(oldId);
  });

  it("already-superseded signal is excluded from opposite-direction lookup", () => {
    // Seed a superseded signal — findOppositePendingForAsset filters to
    // status='pending', so the superseded row should not surface and a
    // new opposite-direction candidate sees no opposite.
    const oldId = "sup-test-old-" + randomUUID();
    seedSignal(oldId, {
      status: "superseded",
      direction: "long",
      asset_id: "tok-btc",
    });
    const found = Signals.findOppositePendingForAsset("tok-btc", "short");
    expect(found).toBeUndefined();
  });

  it("superseding signal that itself gets superseded — both terminal", () => {
    const old1Id = "sup-test-old-" + randomUUID();
    const mid1Id = "sup-test-mid-" + randomUUID();
    const new1Id = "sup-test-new-" + randomUUID();
    // 3-link chain: old1 ← mid1 ← new1.
    seedSignal(old1Id, { status: "superseded", direction: "long" });
    seedSignal(mid1Id, { status: "superseded", direction: "short" });
    seedSignal(new1Id, { status: "pending", direction: "long" });
    insertSupersession({
      superseded_signal_id: old1Id,
      superseding_signal_id: mid1Id,
      significance_ratio: 1.7,
      reason: "old1 → mid1",
    });
    insertSupersession({
      superseded_signal_id: mid1Id,
      superseding_signal_id: new1Id,
      significance_ratio: 1.8,
      reason: "mid1 → new1",
    });
    // mid1 is both 'superseding' (for old1) and 'superseded' (by new1).
    // Each direction is recorded with its own row; nothing else changes.
    const oldRow = getSupersessionForOld(old1Id);
    const midRow = getSupersessionForOld(mid1Id);
    expect(oldRow?.superseding_signal_id).toBe(mid1Id);
    expect(midRow?.superseding_signal_id).toBe(new1Id);

    // The intermediate is no longer a candidate for further supersession:
    // status is 'superseded', not 'pending'.
    const stillPending = Signals.findOppositePendingForAsset("tok-btc", "long");
    // Only new1 (status='pending', direction='long') is pending; lookup
    // for the OPPOSITE of 'long' returns nothing because mid1 is no longer
    // pending.
    expect(stillPending).toBeUndefined();
  });
});

function seedSignal(
  id: string,
  over: Partial<{
    status: string;
    direction: string;
    asset_id: string;
    significance_score: number;
  }>,
) {
  const status = over.status ?? "pending";
  const direction = over.direction ?? "long";
  const assetId = over.asset_id ?? "tok-btc";
  const sig = over.significance_score ?? 0.5;
  db()
    .prepare(
      `INSERT INTO signals
         (id, fired_at, asset_id, sodex_symbol, direction, tier, status,
          confidence, reasoning, significance_score)
       VALUES (?, ?, ?, 'TEST_TEST', ?, 'review', ?, 0.7, 'test seed', ?)`,
    )
    .run(id, Date.now(), assetId, direction, status, sig);
}
