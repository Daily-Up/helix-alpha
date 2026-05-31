/**
 * Part 2 of v2.1 attribution — shadow rebalance ledger. Wave 2: async.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { all, get, run } from "@/lib/db/client";
import {
  ensureShadowsSeeded,
  getShadow,
  listShadows,
  updateShadow,
} from "@/lib/db/repos/shadow-portfolio";
import { setupMemoryDb, teardownMemoryDb } from "./db-setup";

describe("shadow_portfolio repo", () => {
  beforeEach(async () => {
    await setupMemoryDb();
  });
  afterEach(() => teardownMemoryDb());

  it("seeds both v1 and v2 at $10K on first call (idempotent)", async () => {
    await ensureShadowsSeeded(10_000);
    const allRows = await listShadows();
    expect(allRows).toHaveLength(2);
    expect(allRows.find((s) => s.framework_version === "v1")?.nav_usd).toBe(
      10_000,
    );
    expect(allRows.find((s) => s.framework_version === "v2")?.nav_usd).toBe(
      10_000,
    );
    await updateShadow("v1", 11_000, 500);
    await ensureShadowsSeeded(10_000);
    expect((await getShadow("v1"))?.nav_usd).toBe(11_000);
  });

  it("updates NAV + cash for one framework without affecting the other", async () => {
    await ensureShadowsSeeded(10_000);
    await updateShadow("v2", 10_500, 1_000, "2026-05-09 12:00:00");
    const v2 = await getShadow("v2");
    expect(v2?.nav_usd).toBe(10_500);
    expect(v2?.cash_usd).toBe(1_000);
    expect(v2?.last_rebalance_at).toBe("2026-05-09 12:00:00");
    expect((await getShadow("v1"))?.nav_usd).toBe(10_000);
  });

  it("framework switch preserves both NAVs", async () => {
    await ensureShadowsSeeded(10_000);
    await updateShadow("v1", 10_800, 500);
    await updateShadow("v2", 10_200, 800);

    const v1Before = (await getShadow("v1"))!.nav_usd;
    const v2Before = (await getShadow("v2"))!.nav_usd;

    const v1After = (await getShadow("v1"))!.nav_usd;
    const v2After = (await getShadow("v2"))!.nav_usd;
    expect(v1After).toBe(v1Before);
    expect(v2After).toBe(v2Before);
  });
});

describe("shadow signal outcomes — I-40", () => {
  beforeEach(async () => {
    await setupMemoryDb();
    await run(
      `INSERT INTO assets (id, symbol, name, kind, routing) VALUES ('tok-test', 'TEST', 'TEST', 'token', '{}')`,
    );
    await run(
      `INSERT INTO signals (id, asset_id, sodex_symbol, direction, tier, confidence,
                            catalyst_subtype, fired_at, expires_at, status,
                            suggested_target_pct, suggested_stop_pct, expected_horizon,
                            reasoning)
       VALUES ('sig-1', 'tok-test', 'vTEST_vUSDC', 'long', 'review', 0.65,
               'earnings_reaction', ?, ?, 'pending',
               5, 3, '24h',
               'test signal')`,
      [Date.now(), Date.now() + 24 * 3600 * 1000],
    );
  });
  afterEach(() => teardownMemoryDb());

  it("recordShadowOutcome inserts a v2-tagged row with synthetic id", async () => {
    const { recordShadowOutcomeFromSignal } = await import(
      "@/lib/db/repos/outcomes"
    );
    await recordShadowOutcomeFromSignal({
      signal_id: "sig-1",
      framework_version: "v2",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
      target_pct: 8,
      stop_pct: 5,
    });
    const rows = await all<{
      signal_id: string;
      framework_version: string;
      target_pct: number;
      stop_pct: number;
      catalyst_subtype: string;
      conviction: number;
    }>(
      `SELECT signal_id, framework_version, target_pct, stop_pct,
              catalyst_subtype, conviction FROM signal_outcomes
       WHERE framework_version = 'v2'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].signal_id).toMatch(/sig-1.*shadow.*v2/);
    expect(rows[0].catalyst_subtype).toBe("earnings_reaction");
    expect(rows[0].conviction).toBeCloseTo(0.65);
    expect(rows[0].target_pct).toBe(8);
    expect(rows[0].stop_pct).toBe(5);
  });

  it("recordShadowOutcome is idempotent — second call is a no-op", async () => {
    const { recordShadowOutcomeFromSignal } = await import(
      "@/lib/db/repos/outcomes"
    );
    await recordShadowOutcomeFromSignal({
      signal_id: "sig-1",
      framework_version: "v2",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
      target_pct: 8,
      stop_pct: 5,
    });
    await recordShadowOutcomeFromSignal({
      signal_id: "sig-1",
      framework_version: "v2",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
      target_pct: 8,
      stop_pct: 5,
    });
    const count = await get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM signal_outcomes WHERE framework_version = 'v2'`,
    );
    expect(count?.c).toBe(1);
  });

  it("v2 shadow outcome is independent of v1's outcome for the same signal", async () => {
    const { insertOutcomeFromSignal, recordShadowOutcomeFromSignal } =
      await import("@/lib/db/repos/outcomes");
    await insertOutcomeFromSignal({
      signal_id: "sig-1",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
    });
    await recordShadowOutcomeFromSignal({
      signal_id: "sig-1",
      framework_version: "v2",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
      target_pct: 8,
      stop_pct: 5,
    });
    const v1Row = await get<{ framework_version: string; target_pct: number }>(
      `SELECT framework_version, target_pct FROM signal_outcomes WHERE signal_id = 'sig-1'`,
    );
    const v2Row = await get<{ target_pct: number; stop_pct: number }>(
      `SELECT target_pct, stop_pct FROM signal_outcomes
       WHERE framework_version = 'v2' AND signal_id LIKE 'sig-1%shadow%'`,
    );
    expect(v1Row?.framework_version).toBe("v1");
    expect(v1Row?.target_pct).toBe(5);
    expect(v2Row?.target_pct).toBe(8);
    expect(v2Row?.stop_pct).toBe(5);
  });
});

describe("framework_switches repo (Part 3 sneak-peek)", () => {
  beforeEach(async () => {
    await setupMemoryDb();
  });
  afterEach(() => teardownMemoryDb());

  it("recordSwitch + listSwitches round-trip with full context", async () => {
    const { recordSwitch, listSwitches } = await import(
      "@/lib/db/repos/framework-switches"
    );
    await recordSwitch({
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
    const rows = await listSwitches(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].from_version).toBe("v1");
    expect(rows[0].to_version).toBe("v2");
    expect(rows[0].user_confirmed_understanding).toBe(true);
    expect(rows[0].v1_30d_return).toBeCloseTo(5.2);
    expect(rows[0].v2_30d_return).toBeCloseTo(8.4);
  });

  it("switching back to v1 records with confirmed=false (one-directional gate)", async () => {
    const { recordSwitch, listSwitches } = await import(
      "@/lib/db/repos/framework-switches"
    );
    await recordSwitch({
      id: "sw-back",
      from_version: "v2",
      to_version: "v1",
      user_confirmed_understanding: false,
      live_nav_at_switch: 10_500,
      shadow_nav_at_switch: 10_000,
      v1_30d_return: 3.0,
      v2_30d_return: -2.0,
    });
    const rows = await listSwitches(10);
    expect(rows[0].user_confirmed_understanding).toBe(false);
    expect(rows[0].to_version).toBe("v1");
  });
});
