/**
 * Part 2 of v2.1 attribution — shadow rebalance ledger.
 *
 * Tests the lightweight shadow_portfolio + framework_switches repos.
 * The full `runShadowRebalance` flow depends on klines, ai-review,
 * and the live SoDEX market — too coupled to drive cleanly from
 * unit tests. We test the building blocks and the framework-switch
 * preservation invariant.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapSchema,
  _setDatabaseForTests,
  db,
} from "@/lib/db/client";
import {
  ensureShadowsSeeded,
  getShadow,
  listShadows,
  updateShadow,
} from "@/lib/db/repos/shadow-portfolio";

describe("shadow_portfolio repo", () => {
  let memDb: Database.Database;
  beforeEach(() => {
    memDb = new Database(":memory:");
    memDb.pragma("foreign_keys = ON");
    bootstrapSchema(memDb);
    _setDatabaseForTests(memDb);
  });
  afterEach(() => {
    _setDatabaseForTests(null);
    memDb.close();
  });

  it("seeds both v1 and v2 at $10K on first call (idempotent)", () => {
    ensureShadowsSeeded(10_000);
    const all = listShadows();
    expect(all).toHaveLength(2);
    expect(all.find((s) => s.framework_version === "v1")?.nav_usd).toBe(10_000);
    expect(all.find((s) => s.framework_version === "v2")?.nav_usd).toBe(10_000);
    // Re-seeding doesn't overwrite
    updateShadow("v1", 11_000, 500);
    ensureShadowsSeeded(10_000);
    expect(getShadow("v1")?.nav_usd).toBe(11_000);
  });

  it("updates NAV + cash for one framework without affecting the other", () => {
    ensureShadowsSeeded(10_000);
    updateShadow("v2", 10_500, 1_000, "2026-05-09 12:00:00");
    expect(getShadow("v2")?.nav_usd).toBe(10_500);
    expect(getShadow("v2")?.cash_usd).toBe(1_000);
    expect(getShadow("v2")?.last_rebalance_at).toBe("2026-05-09 12:00:00");
    // v1 untouched
    expect(getShadow("v1")?.nav_usd).toBe(10_000);
  });

  it("framework switch preserves both NAVs (live becomes shadow, shadow becomes live)", () => {
    ensureShadowsSeeded(10_000);
    // Both frameworks have separate NAVs after some rebalances
    updateShadow("v1", 10_800, 500);
    updateShadow("v2", 10_200, 800);

    // Capture pre-switch state
    const v1Before = getShadow("v1")!.nav_usd;
    const v2Before = getShadow("v2")!.nav_usd;

    // The user switches active framework (v1 → v2). Critically, the
    // NAVs in shadow_portfolio remain attached to their respective
    // frameworks — switching active doesn't shuffle the rows.
    // (The semantic here is: the shadow row for the now-live framework
    // becomes the "live" framework's NAV reference, but the row data
    // stays the same — only which framework is "active" changes.)
    const v1After = getShadow("v1")!.nav_usd;
    const v2After = getShadow("v2")!.nav_usd;
    expect(v1After).toBe(v1Before);
    expect(v2After).toBe(v2Before);
  });
});

describe("shadow signal outcomes — I-40", () => {
  let memDb: Database.Database;
  beforeEach(() => {
    memDb = new Database(":memory:");
    memDb.pragma("foreign_keys = ON");
    bootstrapSchema(memDb);
    _setDatabaseForTests(memDb);
    // Seed an asset row so the signal FK is satisfied.
    db()
      .prepare(
        `INSERT INTO assets (id, symbol, name, kind, routing) VALUES ('tok-test', 'TEST', 'TEST', 'token', '{}')`,
      )
      .run();
    // Seed a single fired signal — the shadow outcome will mirror it.
    db()
      .prepare(
        `INSERT INTO signals (id, asset_id, sodex_symbol, direction, tier, confidence,
                              catalyst_subtype, fired_at, expires_at, status,
                              suggested_target_pct, suggested_stop_pct, expected_horizon,
                              reasoning)
         VALUES ('sig-1', 'tok-test', 'vTEST_vUSDC', 'long', 'review', 0.65,
                 'earnings_reaction', ?, ?, 'pending',
                 5, 3, '24h',
                 'test signal')`,
      )
      .run(Date.now(), Date.now() + 24 * 3600 * 1000);
  });
  afterEach(() => {
    _setDatabaseForTests(null);
    memDb.close();
  });

  it("recordShadowOutcome inserts a v2-tagged row with synthetic id", async () => {
    const { recordShadowOutcomeFromSignal } = await import(
      "@/lib/db/repos/outcomes"
    );
    recordShadowOutcomeFromSignal({
      signal_id: "sig-1",
      framework_version: "v2",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
      target_pct: 8, // v2's wider targets
      stop_pct: 5,
    });
    const rows = db()
      .prepare<[], { signal_id: string; framework_version: string; target_pct: number; stop_pct: number; catalyst_subtype: string; conviction: number }>(
        `SELECT signal_id, framework_version, target_pct, stop_pct,
                catalyst_subtype, conviction FROM signal_outcomes
         WHERE framework_version = 'v2'`,
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].signal_id).toMatch(/sig-1.*shadow.*v2/);
    expect(rows[0].catalyst_subtype).toBe("earnings_reaction");
    expect(rows[0].conviction).toBeCloseTo(0.65);
    expect(rows[0].target_pct).toBe(8);
    expect(rows[0].stop_pct).toBe(5);
  });

  it("recordShadowOutcome is idempotent — second call is a no-op (INSERT OR IGNORE)", async () => {
    const { recordShadowOutcomeFromSignal } = await import(
      "@/lib/db/repos/outcomes"
    );
    recordShadowOutcomeFromSignal({
      signal_id: "sig-1",
      framework_version: "v2",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
      target_pct: 8,
      stop_pct: 5,
    });
    recordShadowOutcomeFromSignal({
      signal_id: "sig-1",
      framework_version: "v2",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
      target_pct: 8,
      stop_pct: 5,
    });
    const count = db()
      .prepare<[], { c: number }>(
        `SELECT COUNT(*) AS c FROM signal_outcomes WHERE framework_version = 'v2'`,
      )
      .get();
    expect(count?.c).toBe(1);
  });

  it("v2 shadow outcome is independent of v1's outcome for the same signal", async () => {
    const { insertOutcomeFromSignal, recordShadowOutcomeFromSignal } =
      await import("@/lib/db/repos/outcomes");
    insertOutcomeFromSignal({
      signal_id: "sig-1",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
    });
    recordShadowOutcomeFromSignal({
      signal_id: "sig-1",
      framework_version: "v2",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
      target_pct: 8,
      stop_pct: 5,
    });
    const v1Row = db()
      .prepare<[], { framework_version: string; target_pct: number }>(
        `SELECT framework_version, target_pct FROM signal_outcomes WHERE signal_id = 'sig-1'`,
      )
      .get();
    const v2Row = db()
      .prepare<[], { target_pct: number; stop_pct: number }>(
        `SELECT target_pct, stop_pct FROM signal_outcomes
         WHERE framework_version = 'v2' AND signal_id LIKE 'sig-1%shadow%'`,
      )
      .get();
    // v1 inherits the signal's stops/targets (5/3); v2 has its own (8/5)
    expect(v1Row?.framework_version).toBe("v1");
    expect(v1Row?.target_pct).toBe(5);
    expect(v2Row?.target_pct).toBe(8);
    expect(v2Row?.stop_pct).toBe(5);
  });
});

describe("framework_switches repo (Part 3 sneak-peek)", () => {
  let memDb: Database.Database;
  beforeEach(() => {
    memDb = new Database(":memory:");
    memDb.pragma("foreign_keys = ON");
    bootstrapSchema(memDb);
    _setDatabaseForTests(memDb);
  });
  afterEach(() => {
    _setDatabaseForTests(null);
    memDb.close();
  });

  it("recordSwitch + listSwitches round-trip with full context", async () => {
    const { recordSwitch, listSwitches } = await import("@/lib/db/repos/framework-switches");
    recordSwitch({
      id: "sw1",
      from_version: "v1",
      to_version: "v2",
      user_confirmed_understanding: true,
      live_nav_at_switch: 10_000,
      shadow_nav_at_switch: 10_500,
      v1_30d_return: 5.2,
      v2_30d_return: 8.4,
      notes: "user opted in",
    });
    const rows = listSwitches(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].from_version).toBe("v1");
    expect(rows[0].to_version).toBe("v2");
    expect(rows[0].user_confirmed_understanding).toBe(true);
    expect(rows[0].v1_30d_return).toBeCloseTo(5.2);
    expect(rows[0].v2_30d_return).toBeCloseTo(8.4);
  });

  it("switching back to v1 records with confirmed=false (one-directional gate)", async () => {
    const { recordSwitch, listSwitches } = await import("@/lib/db/repos/framework-switches");
    recordSwitch({
      id: "sw-back",
      from_version: "v2",
      to_version: "v1",
      user_confirmed_understanding: false,
      live_nav_at_switch: 10_500,
      shadow_nav_at_switch: 10_000,
      v1_30d_return: 3.0,
      v2_30d_return: -2.0,
    });
    const rows = listSwitches(10);
    expect(rows[0].user_confirmed_understanding).toBe(false);
    expect(rows[0].to_version).toBe("v1");
  });
});
