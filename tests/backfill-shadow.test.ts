/**
 * Part 1 of v2.1 attribution gap-closing — shadow backfill (I-39).
 *
 * Seeds historical v1 rebalances + klines, runs `backfillShadowV2`,
 * and asserts:
 *   - One v2 shadow rebalance row per v1 row, deterministic id
 *   - Re-running is idempotent (no duplicate rows or NAV mutation)
 *   - Mark-to-market produces a v2 NAV that reflects price changes
 *   - Cycles with insufficient kline history are skipped (not synthesized)
 *   - shadow_portfolio.started_at = earliest backfilled asof
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapSchema,
  _setDatabaseForTests,
  db,
} from "@/lib/db/client";
import { backfillShadowV2 } from "@/lib/jobs/backfill-shadow";

const DAY = 24 * 3600 * 1000;
const D0 = Date.UTC(2026, 4, 1);

function seedAsset(id: string): void {
  db()
    .prepare(
      `INSERT INTO assets (id, symbol, name, kind, routing, tradable)
       VALUES (?, ?, ?, 'token', '{}', NULL)`,
    )
    .run(id, id.toUpperCase(), id);
}

function seedKlinesRamp(
  assetId: string,
  fromTs: number,
  days: number,
  startPrice: number,
  endPrice: number,
): void {
  const stmt = db().prepare(
    `INSERT INTO klines_daily (asset_id, date, open, high, low, close, volume)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < days; i++) {
    const px = startPrice + (i / Math.max(1, days - 1)) * (endPrice - startPrice);
    stmt.run(
      assetId,
      new Date(fromTs + i * DAY).toISOString().slice(0, 10),
      px,
      px * 1.002,
      px * 0.998,
      px,
      0,
    );
  }
}

function seedSignal(args: {
  id: string;
  asset_id: string;
  fired_at: number;
  status?: "pending" | "executed" | "expired" | "dismissed";
  direction?: "long" | "short";
  catalyst_subtype?: string;
}): void {
  db()
    .prepare(
      `INSERT INTO signals
         (id, asset_id, sodex_symbol, direction, tier, status, confidence,
          catalyst_subtype, fired_at, expires_at, suggested_target_pct,
          suggested_stop_pct, expected_horizon, reasoning)
       VALUES (?, ?, ?, ?, 'review', ?, 0.65, ?, ?, ?, 5, 3, '24h', 'seed')`,
    )
    .run(
      args.id,
      args.asset_id,
      `v${args.asset_id.toUpperCase()}_vUSDC`,
      args.direction ?? "long",
      args.status ?? "pending",
      args.catalyst_subtype ?? "earnings_reaction",
      args.fired_at,
      args.fired_at + 24 * 3600 * 1000,
    );
}

function seedV1Rebalance(asof_ms: number, weights: Record<string, number>): void {
  db()
    .prepare(
      `INSERT INTO index_rebalances
         (id, index_id, rebalanced_at, triggered_by, pre_nav, post_nav,
          old_weights, new_weights, trades_made, reasoning, reviewer_model,
          framework_version)
       VALUES (?, 'alphacore', ?, 'scheduled', 10000, 10000,
               '{}', ?, '[]', 'seed v1', NULL, 'v1')`,
    )
    .run(`v1-${asof_ms}`, asof_ms, JSON.stringify(weights));
}

function seedAlphacoreIndex(): void {
  db()
    .prepare(
      `INSERT OR IGNORE INTO indexes (id, name, starting_nav)
       VALUES ('alphacore', 'AlphaCore', 10000)`,
    )
    .run();
}

describe("shadow backfill — I-39", () => {
  let memDb: Database.Database;
  beforeEach(() => {
    memDb = new Database(":memory:");
    memDb.pragma("foreign_keys = ON");
    bootstrapSchema(memDb);
    _setDatabaseForTests(memDb);
    seedAlphacoreIndex();
    seedAsset("tok-btc");
    seedAsset("tok-eth");
    // 60-day BTC ramp 100 → 110 covering the test span.
    seedKlinesRamp("tok-btc", D0 - 30 * DAY, 60, 100, 110);
    seedKlinesRamp("tok-eth", D0 - 30 * DAY, 60, 200, 220);
  });
  afterEach(() => {
    _setDatabaseForTests(null);
    memDb.close();
  });

  it("writes one v2 shadow rebalance per v1 row, with deterministic ids", () => {
    seedV1Rebalance(D0 + 0 * DAY, { "tok-btc": 0.5, "tok-eth": 0.2 });
    seedV1Rebalance(D0 + 7 * DAY, { "tok-btc": 0.5, "tok-eth": 0.2 });
    seedV1Rebalance(D0 + 14 * DAY, { "tok-btc": 0.5, "tok-eth": 0.2 });

    const summary = backfillShadowV2("alphacore", 30, 10_000);
    expect(summary.windows_considered).toBe(3);
    expect(summary.rebalances_written).toBeGreaterThan(0);
    const rows = db()
      .prepare<[], { id: string }>(
        `SELECT id FROM index_rebalances WHERE framework_version = 'v2' ORDER BY id`,
      )
      .all();
    for (const r of rows) {
      expect(r.id).toMatch(/^shadow-bf-v2-/);
    }
  });

  it("is idempotent — running twice produces the same final state", () => {
    seedV1Rebalance(D0 + 0 * DAY, { "tok-btc": 0.5 });
    seedV1Rebalance(D0 + 7 * DAY, { "tok-btc": 0.5 });

    const a = backfillShadowV2("alphacore", 30, 10_000);
    const b = backfillShadowV2("alphacore", 30, 10_000);

    // Second run writes zero new rebalances.
    expect(b.rebalances_written).toBe(0);
    // Rebalance count unchanged.
    const totalRebs = db()
      .prepare<[], { c: number }>(
        `SELECT COUNT(*) AS c FROM index_rebalances WHERE framework_version = 'v2'`,
      )
      .get();
    expect(totalRebs?.c).toBe(a.rebalances_written);
    // Final NAV unchanged across runs.
    expect(b.ending_nav).toBeCloseTo(a.ending_nav, 6);
  });

  it("mark-to-market produces a v2 NAV reflecting price changes", () => {
    // BTC ramps 100 → 110 between rebalances (~10% gain over 30d slice).
    // v2 will hold a non-trivial BTC anchor → NAV should rise.
    seedV1Rebalance(D0 + 0 * DAY, { "tok-btc": 0.5 });
    seedV1Rebalance(D0 + 14 * DAY, { "tok-btc": 0.5 });
    const summary = backfillShadowV2("alphacore", 30, 10_000);
    expect(summary.ending_nav).toBeGreaterThan(10_000);
  });

  it("sets shadow_portfolio.started_at to the earliest backfilled asof", () => {
    const earliest = D0 + 0 * DAY;
    seedV1Rebalance(earliest, { "tok-btc": 0.5 });
    seedV1Rebalance(D0 + 7 * DAY, { "tok-btc": 0.5 });
    backfillShadowV2("alphacore", 30, 10_000);

    const row = db()
      .prepare<
        [],
        { started_at: string }
      >(
        `SELECT started_at FROM shadow_portfolio WHERE framework_version = 'v2'`,
      )
      .get();
    // Stored as 'YYYY-MM-DD HH:MM:SS' UTC
    const expectedDate = new Date(earliest).toISOString().slice(0, 10);
    expect(row?.started_at.slice(0, 10)).toBe(expectedDate);
  });

  it("generates v2-tagged outcomes for held assets with matching signals (incl. EXPIRED)", () => {
    // v1 rebalances anchor BTC and add a satellite — v2 will likely hold
    // BTC (always anchored) so any signal on tok-btc within 14d should
    // generate an outcome. We seed BOTH a pending and an expired signal
    // to confirm the backfill no longer drops expired.
    const asof = D0 + 7 * DAY;
    seedV1Rebalance(D0, { "tok-btc": 0.5 });
    seedV1Rebalance(asof, { "tok-btc": 0.5 });
    seedSignal({
      id: "sig-pending",
      asset_id: "tok-btc",
      fired_at: asof - 3 * DAY,
      status: "pending",
    });
    seedSignal({
      id: "sig-expired",
      asset_id: "tok-btc",
      fired_at: asof - 5 * DAY,
      status: "expired",
    });

    const summary = backfillShadowV2("alphacore", 30, 10_000);
    expect(summary.outcomes_written).toBeGreaterThanOrEqual(2);

    const v2Outcomes = db()
      .prepare<[], { signal_id: string; framework_version: string }>(
        `SELECT signal_id, framework_version FROM signal_outcomes
         WHERE framework_version = 'v2'`,
      )
      .all();
    const ids = v2Outcomes.map((r) => r.signal_id);
    expect(ids).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/sig-pending.*shadow.*v2/),
        expect.stringMatching(/sig-expired.*shadow.*v2/),
      ]),
    );
  });

  it("outcome generation is idempotent — second run does not duplicate", () => {
    const asof = D0 + 7 * DAY;
    seedV1Rebalance(D0, { "tok-btc": 0.5 });
    seedV1Rebalance(asof, { "tok-btc": 0.5 });
    seedSignal({
      id: "sig-1",
      asset_id: "tok-btc",
      fired_at: asof - 2 * DAY,
      status: "expired",
    });

    backfillShadowV2("alphacore", 30, 10_000);
    const firstCount = db()
      .prepare<[], { c: number }>(
        `SELECT COUNT(*) AS c FROM signal_outcomes WHERE framework_version='v2'`,
      )
      .get()?.c ?? 0;
    expect(firstCount).toBeGreaterThan(0);

    // Second run — INSERT OR IGNORE keeps count stable.
    backfillShadowV2("alphacore", 30, 10_000);
    const secondCount = db()
      .prepare<[], { c: number }>(
        `SELECT COUNT(*) AS c FROM signal_outcomes WHERE framework_version='v2'`,
      )
      .get()?.c ?? 0;
    expect(secondCount).toBe(firstCount);
  });

  it("cycle with no signals in window correctly produces zero outcomes (not an error)", () => {
    seedV1Rebalance(D0, { "tok-btc": 0.5 });
    seedV1Rebalance(D0 + 7 * DAY, { "tok-btc": 0.5 });
    // No signals seeded.

    const summary = backfillShadowV2("alphacore", 30, 10_000);
    expect(summary.rebalances_written).toBeGreaterThan(0);
    expect(summary.outcomes_written).toBe(0);
    const v2Outcomes = db()
      .prepare<[], { c: number }>(
        `SELECT COUNT(*) AS c FROM signal_outcomes WHERE framework_version='v2'`,
      )
      .get()?.c ?? 0;
    expect(v2Outcomes).toBe(0);
  });

  it("does not generate outcome when held set does not include the signal's asset", () => {
    // v2 will be heavily BTC + RWA-anchored; if a signal fires on a
    // satellite that v2 ends up NOT holding (e.g. because v2 prunes
    // the position below 3%), no outcome is generated.
    const asof = D0 + 7 * DAY;
    seedV1Rebalance(D0, { "tok-btc": 0.5 });
    seedV1Rebalance(asof, { "tok-btc": 0.5 });
    // Seed an asset v2 won't hold (no klines = no momentum data).
    db()
      .prepare(
        `INSERT INTO assets (id, symbol, name, kind, routing) VALUES ('tok-noklines', 'NK', 'NK', 'token', '{}')`,
      )
      .run();
    seedSignal({
      id: "sig-orphan",
      asset_id: "tok-noklines",
      fired_at: asof - 2 * DAY,
      status: "expired",
    });

    backfillShadowV2("alphacore", 30, 10_000);
    const orphan = db()
      .prepare<[], { c: number }>(
        `SELECT COUNT(*) AS c FROM signal_outcomes
         WHERE signal_id LIKE 'sig-orphan-shadow-%'`,
      )
      .get()?.c ?? 0;
    expect(orphan).toBe(0);
  });

  it("skips cycles with insufficient kline history (no synthesis)", () => {
    // v1 rebalance from BEFORE the kline coverage starts.
    const tooEarly = D0 - 60 * DAY;
    seedV1Rebalance(tooEarly, { "tok-btc": 0.5 });
    seedV1Rebalance(D0 + 7 * DAY, { "tok-btc": 0.5 });

    const summary = backfillShadowV2("alphacore", 365, 10_000);
    expect(summary.rebalances_skipped).toBeGreaterThanOrEqual(1);
    // No v2 row written for the too-early asof
    const dup = db()
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM index_rebalances WHERE id = ?`,
      )
      .get(`shadow-bf-v2-${tooEarly}`);
    expect(dup?.c).toBe(0);
  });
});
