/**
 * Part 1 of v2.1 attribution gap-closing — shadow backfill (I-39).
 * Wave 2: async libSQL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, get, run } from "@/lib/db/client";
import { backfillShadowV2 } from "@/lib/jobs/backfill-shadow";
import { setupMemoryDb, teardownMemoryDb } from "./db-setup";

const DAY = 24 * 3600 * 1000;
const D0 = Date.UTC(2026, 4, 1);
// Freeze "now" inside the test so the 30-day lookback always includes D0+15.
const NOW = D0 + 20 * DAY;

async function seedAsset(id: string): Promise<void> {
  await run(
    `INSERT INTO assets (id, symbol, name, kind, routing, tradable)
     VALUES (?, ?, ?, 'token', '{}', NULL)`,
    [id, id.toUpperCase(), id],
  );
}

async function seedKlinesRamp(
  assetId: string,
  fromTs: number,
  days: number,
  startPrice: number,
  endPrice: number,
): Promise<void> {
  for (let i = 0; i < days; i++) {
    const px = startPrice + (i / Math.max(1, days - 1)) * (endPrice - startPrice);
    await run(
      `INSERT INTO klines_daily (asset_id, date, open, high, low, close, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        assetId,
        new Date(fromTs + i * DAY).toISOString().slice(0, 10),
        px,
        px * 1.002,
        px * 0.998,
        px,
        0,
      ],
    );
  }
}

async function seedSignal(args: {
  id: string;
  asset_id: string;
  fired_at: number;
  status?: "pending" | "executed" | "expired" | "dismissed";
  direction?: "long" | "short";
  catalyst_subtype?: string;
}): Promise<void> {
  await run(
    `INSERT INTO signals
       (id, asset_id, sodex_symbol, direction, tier, status, confidence,
        catalyst_subtype, fired_at, expires_at, suggested_target_pct,
        suggested_stop_pct, expected_horizon, reasoning)
     VALUES (?, ?, ?, ?, 'review', ?, 0.65, ?, ?, ?, 5, 3, '24h', 'seed')`,
    [
      args.id,
      args.asset_id,
      `v${args.asset_id.toUpperCase()}_vUSDC`,
      args.direction ?? "long",
      args.status ?? "pending",
      args.catalyst_subtype ?? "earnings_reaction",
      args.fired_at,
      args.fired_at + 24 * 3600 * 1000,
    ],
  );
}

async function seedV1Rebalance(
  asof_ms: number,
  weights: Record<string, number>,
): Promise<void> {
  await run(
    `INSERT INTO index_rebalances
       (id, index_id, rebalanced_at, triggered_by, pre_nav, post_nav,
        old_weights, new_weights, trades_made, reasoning, reviewer_model,
        framework_version)
     VALUES (?, 'alphacore', ?, 'scheduled', 10000, 10000,
             '{}', ?, '[]', 'seed v1', NULL, 'v1')`,
    [`v1-${asof_ms}`, asof_ms, JSON.stringify(weights)],
  );
}

async function seedAlphacoreIndex(): Promise<void> {
  await run(
    `INSERT OR IGNORE INTO indexes (id, name, starting_nav)
     VALUES ('alphacore', 'AlphaCore', 10000)`,
  );
}

describe("shadow backfill — I-39", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    await setupMemoryDb();
    await seedAlphacoreIndex();
    await seedAsset("tok-btc");
    await seedAsset("tok-eth");
    await seedKlinesRamp("tok-btc", D0 - 30 * DAY, 60, 100, 110);
    await seedKlinesRamp("tok-eth", D0 - 30 * DAY, 60, 200, 220);
  });
  afterEach(() => {
    teardownMemoryDb();
    vi.useRealTimers();
  });

  it("writes one v2 shadow rebalance per v1 row, with deterministic ids", async () => {
    await seedV1Rebalance(D0 + 0 * DAY, { "tok-btc": 0.5, "tok-eth": 0.2 });
    await seedV1Rebalance(D0 + 7 * DAY, { "tok-btc": 0.5, "tok-eth": 0.2 });
    await seedV1Rebalance(D0 + 14 * DAY, { "tok-btc": 0.5, "tok-eth": 0.2 });

    const summary = await backfillShadowV2("alphacore", 30, 10_000);
    expect(summary.windows_considered).toBe(3);
    expect(summary.rebalances_written).toBeGreaterThan(0);
    const rows = await all<{ id: string }>(
      `SELECT id FROM index_rebalances WHERE framework_version = 'v2' ORDER BY id`,
    );
    for (const r of rows) {
      expect(r.id).toMatch(/^shadow-bf-v2-/);
    }
  });

  it("is idempotent — running twice produces the same final state", async () => {
    await seedV1Rebalance(D0 + 0 * DAY, { "tok-btc": 0.5 });
    await seedV1Rebalance(D0 + 7 * DAY, { "tok-btc": 0.5 });

    const a = await backfillShadowV2("alphacore", 30, 10_000);
    const b = await backfillShadowV2("alphacore", 30, 10_000);

    expect(b.rebalances_written).toBe(0);
    const totalRebs = await get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM index_rebalances WHERE framework_version = 'v2'`,
    );
    expect(totalRebs?.c).toBe(a.rebalances_written);
    expect(b.ending_nav).toBeCloseTo(a.ending_nav, 6);
  });

  it("mark-to-market produces a v2 NAV reflecting price changes", async () => {
    await seedV1Rebalance(D0 + 0 * DAY, { "tok-btc": 0.5 });
    await seedV1Rebalance(D0 + 14 * DAY, { "tok-btc": 0.5 });
    const summary = await backfillShadowV2("alphacore", 30, 10_000);
    expect(summary.ending_nav).toBeGreaterThan(10_000);
  });

  it("sets shadow_portfolio.started_at to the earliest backfilled asof", async () => {
    const earliest = D0 + 0 * DAY;
    await seedV1Rebalance(earliest, { "tok-btc": 0.5 });
    await seedV1Rebalance(D0 + 7 * DAY, { "tok-btc": 0.5 });
    await backfillShadowV2("alphacore", 30, 10_000);

    const row = await get<{ started_at: string }>(
      `SELECT started_at FROM shadow_portfolio WHERE framework_version = 'v2'`,
    );
    const expectedDate = new Date(earliest).toISOString().slice(0, 10);
    expect(row?.started_at.slice(0, 10)).toBe(expectedDate);
  });

  it("generates v2-tagged outcomes for held assets with matching signals (incl. EXPIRED)", async () => {
    const asof = D0 + 7 * DAY;
    await seedV1Rebalance(D0, { "tok-btc": 0.5 });
    await seedV1Rebalance(asof, { "tok-btc": 0.5 });
    await seedSignal({
      id: "sig-pending",
      asset_id: "tok-btc",
      fired_at: asof - 3 * DAY,
      status: "pending",
    });
    await seedSignal({
      id: "sig-expired",
      asset_id: "tok-btc",
      fired_at: asof - 5 * DAY,
      status: "expired",
    });

    const summary = await backfillShadowV2("alphacore", 30, 10_000);
    expect(summary.outcomes_written).toBeGreaterThanOrEqual(2);

    const v2Outcomes = await all<{
      signal_id: string;
      framework_version: string;
    }>(
      `SELECT signal_id, framework_version FROM signal_outcomes
       WHERE framework_version = 'v2'`,
    );
    const ids = v2Outcomes.map((r) => r.signal_id);
    expect(ids).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/sig-pending.*shadow.*v2/),
        expect.stringMatching(/sig-expired.*shadow.*v2/),
      ]),
    );
  });

  it("outcome generation is idempotent — second run does not duplicate", async () => {
    const asof = D0 + 7 * DAY;
    await seedV1Rebalance(D0, { "tok-btc": 0.5 });
    await seedV1Rebalance(asof, { "tok-btc": 0.5 });
    await seedSignal({
      id: "sig-1",
      asset_id: "tok-btc",
      fired_at: asof - 2 * DAY,
      status: "expired",
    });

    await backfillShadowV2("alphacore", 30, 10_000);
    const firstCount =
      (
        await get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM signal_outcomes WHERE framework_version='v2'`,
        )
      )?.c ?? 0;
    expect(firstCount).toBeGreaterThan(0);

    await backfillShadowV2("alphacore", 30, 10_000);
    const secondCount =
      (
        await get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM signal_outcomes WHERE framework_version='v2'`,
        )
      )?.c ?? 0;
    expect(secondCount).toBe(firstCount);
  });

  it("cycle with no signals in window correctly produces zero outcomes (not an error)", async () => {
    await seedV1Rebalance(D0, { "tok-btc": 0.5 });
    await seedV1Rebalance(D0 + 7 * DAY, { "tok-btc": 0.5 });

    const summary = await backfillShadowV2("alphacore", 30, 10_000);
    expect(summary.rebalances_written).toBeGreaterThan(0);
    expect(summary.outcomes_written).toBe(0);
    const v2Outcomes =
      (
        await get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM signal_outcomes WHERE framework_version='v2'`,
        )
      )?.c ?? 0;
    expect(v2Outcomes).toBe(0);
  });

  it("does not generate outcome when held set does not include the signal's asset", async () => {
    const asof = D0 + 7 * DAY;
    await seedV1Rebalance(D0, { "tok-btc": 0.5 });
    await seedV1Rebalance(asof, { "tok-btc": 0.5 });
    await run(
      `INSERT INTO assets (id, symbol, name, kind, routing) VALUES ('tok-noklines', 'NK', 'NK', 'token', '{}')`,
    );
    await seedSignal({
      id: "sig-orphan",
      asset_id: "tok-noklines",
      fired_at: asof - 2 * DAY,
      status: "expired",
    });

    await backfillShadowV2("alphacore", 30, 10_000);
    const orphan =
      (
        await get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM signal_outcomes
           WHERE signal_id LIKE 'sig-orphan-shadow-%'`,
        )
      )?.c ?? 0;
    expect(orphan).toBe(0);
  });

  it("skips cycles with insufficient kline history (no synthesis)", async () => {
    const tooEarly = D0 - 60 * DAY;
    await seedV1Rebalance(tooEarly, { "tok-btc": 0.5 });
    await seedV1Rebalance(D0 + 7 * DAY, { "tok-btc": 0.5 });

    const summary = await backfillShadowV2("alphacore", 365, 10_000);
    expect(summary.rebalances_skipped).toBeGreaterThanOrEqual(1);
    const dup = await get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM index_rebalances WHERE id = ?`,
      [`shadow-bf-v2-${tooEarly}`],
    );
    expect(dup?.c).toBe(0);
  });
});
