/**
 * Lifecycle sweep — uncorroborated rule respects source_tier. Wave 2: async.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { get, run } from "../src/lib/db";
import * as Signals from "../src/lib/db/repos/signals";
import { setupMemoryDb, teardownMemoryDb } from "./db-setup";

beforeEach(async () => {
  await setupMemoryDb();
  await run(
    `INSERT OR IGNORE INTO assets (id, symbol, name, kind, tags, routing, rank, tradable)
     VALUES ('tok-sol', 'SOL', 'Solana', 'token', '[]', '{}', 1, NULL)`,
  );
  await run(
    `INSERT OR IGNORE INTO news_events
       (id, release_time, title, category, raw_json)
     VALUES ('news-1', ?, 'Some news', 1, '{}')`,
    [Date.now() - 24 * 60 * 60 * 1000],
  );
});
afterEach(() => teardownMemoryDb());

async function seed(opts: { sourceTier: number | null; pastDeadline: boolean }) {
  const now = Date.now();
  const deadline = opts.pastDeadline
    ? now - 60 * 60 * 1000
    : now + 60 * 60 * 1000;
  await run(
    `INSERT INTO signals
       (id, fired_at, triggered_by_event_id, asset_id, sodex_symbol,
        direction, tier, status, confidence, reasoning,
        corroboration_deadline, source_tier)
     VALUES ('test-1', ?, 'news-1', 'tok-sol', 'vSOL_vUSDC', 'long',
             'review', 'pending', 0.7, 'test seed', ?, ?)`,
    [now, deadline, opts.sourceTier],
  );
}

describe("sweepExpiredSignals — source-tier gate (I-47-bugfix)", () => {
  it("does NOT mark tier-1 signal uncorroborated even if deadline elapsed", async () => {
    await seed({ sourceTier: 1, pastDeadline: true });
    const result = await Signals.sweepExpiredSignals();
    expect(result.uncorroborated).toBe(0);
    const row = await get<{ status: string }>(
      "SELECT status FROM signals WHERE id = 'test-1'",
    );
    expect(row?.status).toBe("pending");
  });

  it("does NOT mark tier-2 signal uncorroborated even if deadline elapsed", async () => {
    await seed({ sourceTier: 2, pastDeadline: true });
    const result = await Signals.sweepExpiredSignals();
    expect(result.uncorroborated).toBe(0);
    const row = await get<{ status: string }>(
      "SELECT status FROM signals WHERE id = 'test-1'",
    );
    expect(row?.status).toBe("pending");
  });

  it("DOES mark tier-3 signal uncorroborated when deadline elapsed and no corroboration", async () => {
    await seed({ sourceTier: 3, pastDeadline: true });
    const result = await Signals.sweepExpiredSignals();
    expect(result.uncorroborated).toBe(1);
    const row = await get<{ status: string; dismiss_reason: string }>(
      "SELECT status, dismiss_reason FROM signals WHERE id = 'test-1'",
    );
    expect(row?.status).toBe("expired");
    expect(row?.dismiss_reason).toBe("uncorroborated");
  });

  it("does NOT touch tier-3 if deadline hasn't elapsed yet", async () => {
    await seed({ sourceTier: 3, pastDeadline: false });
    const result = await Signals.sweepExpiredSignals();
    expect(result.uncorroborated).toBe(0);
  });

  it("does NOT touch legacy NULL source_tier rows", async () => {
    await seed({ sourceTier: null, pastDeadline: true });
    const result = await Signals.sweepExpiredSignals();
    expect(result.uncorroborated).toBe(0);
  });

  it("tier-3 with at least one duplicate news_event covering same story → not swept", async () => {
    await seed({ sourceTier: 3, pastDeadline: true });
    await run(
      `INSERT INTO news_events
         (id, release_time, title, category, raw_json, duplicate_of)
       VALUES ('news-dup', ?, 'duplicate coverage', 1, '{}', 'news-1')`,
      [Date.now()],
    );
    const result = await Signals.sweepExpiredSignals();
    expect(result.uncorroborated).toBe(0);
  });
});
