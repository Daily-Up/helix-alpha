/**
 * Regression test for the signal-generator dedup bug.
 *
 * Symptom on prod: tok-btc long regulatory event_id `20618347…` fired
 * 4 times in 3.5h on 2026-06-03 — same event, same asset, same
 * direction, same event_type. Other catalysts hit double-digit fire
 * counts for the same (asset, direction, event_type) on a single day
 * (perp-us500 macro_print, tok-hype etf_flow, …).
 *
 * Root cause: both dedup queries (`existsForEventAsset` and
 * `existsRecentForAssetDirection`) gated on `status IN (…)` excluding
 * `expired` / `dismissed` / `blocked`. The lifecycle sweeper moves
 * regulatory_statement signals to `expired` within ~30 min, so by
 * the second tick the first signal had vanished from the dedup view.
 *
 * Fix: dedup means "did we EVER fire," not "is it still pending."
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { run } from "../src/lib/db";
import * as Signals from "../src/lib/db/repos/signals";
import { setupMemoryDb, teardownMemoryDb } from "./db-setup";

const EVENT_ID = "evt-dedup-test";
const ASSET_ID = "tok-btc";

beforeAll(async () => {
  await setupMemoryDb();
  await run(
    `INSERT OR IGNORE INTO assets
       (id, symbol, name, kind, tags, routing, rank, tradable)
     VALUES ('tok-btc', 'BTC', 'Bitcoin', 'token', '[]', '{}', 1, NULL)`,
  );
  await run(
    `INSERT OR IGNORE INTO news_events
       (id, release_time, title, content, author, source_link,
        original_link, category, tags, matched_currencies,
        is_blue_verified, raw_json, ingested_at)
     VALUES (?, ?, 'SEC speech', 'body', 'sec.gov', NULL, NULL, 1, NULL, NULL, 0, '{}', ?)`,
    [EVENT_ID, Date.now() - 60_000, Date.now()],
  );
  await run(
    `INSERT OR IGNORE INTO classifications
       (event_id, event_type, sentiment, severity, confidence,
        affected_asset_ids, reasoning, model)
     VALUES (?, 'regulatory', 'positive', 'high', 0.7, ?, 'r', 'test')`,
    [EVENT_ID, JSON.stringify([ASSET_ID])],
  );
});
afterAll(() => teardownMemoryDb());

beforeEach(async () => {
  await run(`DELETE FROM signals WHERE triggered_by_event_id = ?`, [EVENT_ID]);
});

async function insertSignal(status: string, firedOffsetMs = 0) {
  const id = `sig-${status}-${Math.random().toString(36).slice(2, 8)}`;
  await run(
    `INSERT INTO signals
       (id, fired_at, triggered_by_event_id, pattern_id, asset_id,
        sodex_symbol, direction, tier, status, confidence,
        expected_impact_pct, expected_horizon, suggested_size_usd,
        suggested_stop_pct, suggested_target_pct, reasoning,
        secondary_asset_ids, catalyst_subtype, expires_at)
     VALUES (?, ?, ?, NULL, ?, 'BTC-USDT', 'long', 'review', ?, 0.7,
             5, '24h', 100, 5, 10, 'r', NULL, 'regulatory_statement', ?)`,
    [
      id,
      Date.now() + firedOffsetMs,
      EVENT_ID,
      ASSET_ID,
      status,
      Date.now() + firedOffsetMs + 3_600_000,
    ],
  );
  return id;
}

describe("signal-generator dedup — status-agnostic regression", () => {
  it("existsForEventAsset: an EXPIRED prior signal still counts as a dup", async () => {
    await insertSignal("expired", -2 * 60_000); // 2 min ago
    const dup = await Signals.existsForEventAsset(EVENT_ID, ASSET_ID);
    expect(dup).toBe(true);
  });

  it("existsForEventAsset: a DISMISSED prior signal still counts", async () => {
    await insertSignal("dismissed", -5 * 60_000);
    expect(await Signals.existsForEventAsset(EVENT_ID, ASSET_ID)).toBe(true);
  });

  it("existsForEventAsset: a BLOCKED prior signal still counts", async () => {
    await insertSignal("blocked", -5 * 60_000);
    expect(await Signals.existsForEventAsset(EVENT_ID, ASSET_ID)).toBe(true);
  });

  it("existsForEventAsset: PENDING prior still counts (unchanged)", async () => {
    await insertSignal("pending", -60_000);
    expect(await Signals.existsForEventAsset(EVENT_ID, ASSET_ID)).toBe(true);
  });

  it("existsForEventAsset: NO prior → false", async () => {
    expect(await Signals.existsForEventAsset(EVENT_ID, ASSET_ID)).toBe(false);
  });

  it("existsRecentForAssetDirection: EXPIRED prior within window still dedupes", async () => {
    await insertSignal("expired", -30 * 60_000); // 30 min ago
    const dup = await Signals.existsRecentForAssetDirection(
      ASSET_ID,
      "long",
      "regulatory",
      12 * 3_600_000, // 12h window
    );
    expect(dup).toBe(true);
  });

  it("existsRecentForAssetDirection: signal OLDER than window is ignored", async () => {
    await insertSignal("pending", -13 * 3_600_000); // 13h ago, window=12h
    expect(
      await Signals.existsRecentForAssetDirection(
        ASSET_ID,
        "long",
        "regulatory",
        12 * 3_600_000,
      ),
    ).toBe(false);
  });

  it("existsRecentForAssetDirection: different event_type does not dedupe", async () => {
    // Insert a regulatory signal, then ask about a different type.
    await insertSignal("pending", -30 * 60_000);
    expect(
      await Signals.existsRecentForAssetDirection(
        ASSET_ID,
        "long",
        "exploit",
        12 * 3_600_000,
      ),
    ).toBe(false);
  });
});
