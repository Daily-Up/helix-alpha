/**
 * Live supersession tests (Phase E, I-43). Wave 2: async libSQL.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  resolveConflict,
  type ConflictCandidate,
} from "../src/lib/calibration/conflicts";
import { run } from "../src/lib/db";
import * as Signals from "../src/lib/db/repos/signals";
import {
  insertSupersession,
  getSupersessionForOld,
  listSupersessionsByNew,
} from "../src/lib/db/repos/conflicts";
import { setupMemoryDb, teardownMemoryDb } from "./db-setup";

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

beforeAll(async () => {
  await setupMemoryDb();
  await run(
    `INSERT OR IGNORE INTO assets
       (id, symbol, name, kind, tags, routing, rank, tradable)
     VALUES ('tok-btc', 'BTC', 'Bitcoin', 'token', '[]', '{}', 1, NULL)`,
  );
});
afterAll(() => teardownMemoryDb());

beforeEach(async () => {
  await run("DELETE FROM signal_supersessions");
  await run("DELETE FROM signals WHERE id LIKE 'sup-test-%'");
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
      significance_score: 0.8,
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
      significance_score: 0.7,
    });
    const verdict = resolveConflict(newCand, existing);
    expect(verdict.kind).toBe("suppress_existing");
  });

  it("inserts a signal_supersessions row with ratio + reason", async () => {
    const oldId = "sup-test-old-" + randomUUID();
    const newId = "sup-test-new-" + randomUUID();
    await seedSignal(oldId, { status: "superseded" });
    await seedSignal(newId, { status: "pending" });
    await insertSupersession({
      superseded_signal_id: oldId,
      superseding_signal_id: newId,
      significance_ratio: 1.7,
      reason: "test supersession",
    });
    const row = await getSupersessionForOld(oldId);
    expect(row).toBeDefined();
    expect(row!.significance_ratio).toBe(1.7);
    expect(row!.reason).toBe("test supersession");

    const byNew = await listSupersessionsByNew(newId);
    expect(byNew).toHaveLength(1);
    expect(byNew[0].superseded_signal_id).toBe(oldId);
  });

  it("already-superseded signal is excluded from opposite-direction lookup", async () => {
    const oldId = "sup-test-old-" + randomUUID();
    await seedSignal(oldId, {
      status: "superseded",
      direction: "long",
      asset_id: "tok-btc",
    });
    const found = await Signals.findOppositePendingForAsset("tok-btc", "short");
    expect(found).toBeUndefined();
  });

  it("superseding signal that itself gets superseded — both terminal", async () => {
    const old1Id = "sup-test-old-" + randomUUID();
    const mid1Id = "sup-test-mid-" + randomUUID();
    const new1Id = "sup-test-new-" + randomUUID();
    await seedSignal(old1Id, { status: "superseded", direction: "long" });
    await seedSignal(mid1Id, { status: "superseded", direction: "short" });
    await seedSignal(new1Id, { status: "pending", direction: "long" });
    await insertSupersession({
      superseded_signal_id: old1Id,
      superseding_signal_id: mid1Id,
      significance_ratio: 1.7,
      reason: "old1 → mid1",
    });
    await insertSupersession({
      superseded_signal_id: mid1Id,
      superseding_signal_id: new1Id,
      significance_ratio: 1.8,
      reason: "mid1 → new1",
    });
    const oldRow = await getSupersessionForOld(old1Id);
    const midRow = await getSupersessionForOld(mid1Id);
    expect(oldRow?.superseding_signal_id).toBe(mid1Id);
    expect(midRow?.superseding_signal_id).toBe(new1Id);

    const stillPending = await Signals.findOppositePendingForAsset(
      "tok-btc",
      "long",
    );
    expect(stillPending).toBeUndefined();
  });
});

async function seedSignal(
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
  await run(
    `INSERT INTO signals
       (id, fired_at, asset_id, sodex_symbol, direction, tier, status,
        confidence, reasoning, significance_score)
     VALUES (?, ?, ?, 'TEST_TEST', ?, 'review', ?, 0.7, 'test seed', ?)`,
    [id, Date.now(), assetId, direction, status, sig],
  );
}
