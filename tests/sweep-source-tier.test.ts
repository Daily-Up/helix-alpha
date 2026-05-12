/**
 * Lifecycle sweep — uncorroborated rule respects source_tier.
 *
 * Tier-1 (Bloomberg/SEC/Reuters) and tier-2 (PANews/Decrypt/CoinDesk)
 * sources are recognised outlets — single coverage from them is real
 * signal and shouldn't get auto-killed for lack of a sibling outlet.
 * Only tier-3 (KOL/anon) needs the corroboration gate.
 *
 * Without this protection, legitimate tech_update / regulatory /
 * partnership signals from primary sources were getting swept after 8h
 * just because no one re-tweeted the story.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { bootstrapSchema, _setDatabaseForTests, db } from "../src/lib/db";
import * as Signals from "../src/lib/db/repos/signals";

beforeEach(() => {
  const conn = new Database(":memory:");
  conn.pragma("foreign_keys = ON");
  bootstrapSchema(conn);
  _setDatabaseForTests(conn);
  db()
    .prepare(
      `INSERT OR IGNORE INTO assets (id, symbol, name, kind, tags, routing, rank, tradable)
       VALUES ('tok-sol', 'SOL', 'Solana', 'token', '[]', '{}', 1, NULL)`,
    )
    .run();
  db()
    .prepare(
      `INSERT OR IGNORE INTO news_events
         (id, release_time, title, category, raw_json)
       VALUES ('news-1', ?, 'Some news', 1, '{}')`,
    )
    .run(Date.now() - 24 * 60 * 60 * 1000);
});

function seed(opts: { sourceTier: number | null; pastDeadline: boolean }) {
  const now = Date.now();
  const deadline = opts.pastDeadline ? now - 60 * 60 * 1000 : now + 60 * 60 * 1000;
  db()
    .prepare(
      `INSERT INTO signals
         (id, fired_at, triggered_by_event_id, asset_id, sodex_symbol,
          direction, tier, status, confidence, reasoning,
          corroboration_deadline, source_tier)
       VALUES ('test-1', ?, 'news-1', 'tok-sol', 'vSOL_vUSDC', 'long',
               'review', 'pending', 0.7, 'test seed', ?, ?)`,
    )
    .run(now, deadline, opts.sourceTier);
}

describe("sweepExpiredSignals — source-tier gate (I-47-bugfix)", () => {
  it("does NOT mark tier-1 signal uncorroborated even if deadline elapsed", () => {
    seed({ sourceTier: 1, pastDeadline: true });
    const result = Signals.sweepExpiredSignals();
    expect(result.uncorroborated).toBe(0);
    const row = db().prepare<[], { status: string }>(
      "SELECT status FROM signals WHERE id = 'test-1'",
    ).get();
    expect(row?.status).toBe("pending");
  });

  it("does NOT mark tier-2 signal uncorroborated even if deadline elapsed", () => {
    seed({ sourceTier: 2, pastDeadline: true });
    const result = Signals.sweepExpiredSignals();
    expect(result.uncorroborated).toBe(0);
    const row = db().prepare<[], { status: string }>(
      "SELECT status FROM signals WHERE id = 'test-1'",
    ).get();
    expect(row?.status).toBe("pending");
  });

  it("DOES mark tier-3 signal uncorroborated when deadline elapsed and no corroboration", () => {
    seed({ sourceTier: 3, pastDeadline: true });
    const result = Signals.sweepExpiredSignals();
    expect(result.uncorroborated).toBe(1);
    const row = db().prepare<[], { status: string; dismiss_reason: string }>(
      "SELECT status, dismiss_reason FROM signals WHERE id = 'test-1'",
    ).get();
    expect(row?.status).toBe("expired");
    expect(row?.dismiss_reason).toBe("uncorroborated");
  });

  it("does NOT touch tier-3 if deadline hasn't elapsed yet", () => {
    seed({ sourceTier: 3, pastDeadline: false });
    const result = Signals.sweepExpiredSignals();
    expect(result.uncorroborated).toBe(0);
  });

  it("does NOT touch legacy NULL source_tier rows (pre-pipeline-wiring)", () => {
    seed({ sourceTier: null, pastDeadline: true });
    const result = Signals.sweepExpiredSignals();
    expect(result.uncorroborated).toBe(0);
  });

  it("tier-3 with at least one duplicate news_event covering same story → not swept", () => {
    seed({ sourceTier: 3, pastDeadline: true });
    // Insert a corroborating news_event pointing at our triggering event.
    db()
      .prepare(
        `INSERT INTO news_events
           (id, release_time, title, category, raw_json, duplicate_of)
         VALUES ('news-dup', ?, 'duplicate coverage', 1, '{}', 'news-1')`,
      )
      .run(Date.now());
    const result = Signals.sweepExpiredSignals();
    expect(result.uncorroborated).toBe(0);
  });
});
