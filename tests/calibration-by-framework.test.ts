/**
 * Part 1 of v2.1 attribution — calibration queries split by framework.
 *
 * Seeds outcomes tagged across both frameworks and asserts the
 * existing queries respect a `frameworkVersion` filter, plus the new
 * comparison queries return both frameworks' aggregates with deltas.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapSchema,
  _setDatabaseForTests,
  db,
} from "@/lib/db/client";
import {
  hitRateByTier,
  getHitRateByFrameworkAndTier,
  getPnlByFrameworkAndCatalystSubtype,
  getCalibrationCurveByFramework,
  getFrameworkSummary,
} from "@/lib/queries/calibration";

const NOW = Date.UTC(2026, 4, 9, 12, 0, 0);

interface SeedRow {
  signal_id: string;
  framework_version: "v1" | "v2";
  tier: "auto" | "review" | "info";
  conviction: number;
  catalyst_subtype: string;
  asset_class: string;
  outcome: string;
  realized_pct: number | null;
  realized_pnl_usd: number | null;
  daysAgo: number;
}

function seed(): SeedRow[] {
  const rows: SeedRow[] = [];
  let i = 0;
  const push = (
    fw: "v1" | "v2",
    tier: "auto" | "review" | "info",
    sub: string,
    cls: string,
    outcome: string,
    realized: number | null,
    conv = 0.6,
  ) => {
    rows.push({
      signal_id: `sig-${i++}`,
      framework_version: fw,
      tier,
      conviction: conv,
      catalyst_subtype: sub,
      asset_class: cls,
      outcome,
      realized_pct: realized,
      realized_pnl_usd: realized != null ? realized * 5 : null,
      daysAgo: i % 25,
    });
  };

  // v1: 6 wins, 4 losses on REVIEW tier earnings
  for (let k = 0; k < 6; k++) push("v1", "review", "earnings_reaction", "large_cap_crypto", "target_hit", 5);
  for (let k = 0; k < 4; k++) push("v1", "review", "earnings_reaction", "large_cap_crypto", "stop_hit", -3);

  // v2: 5 wins, 2 losses on REVIEW tier earnings (better hit rate)
  for (let k = 0; k < 5; k++) push("v2", "review", "earnings_reaction", "large_cap_crypto", "target_hit", 6);
  for (let k = 0; k < 2; k++) push("v2", "review", "earnings_reaction", "large_cap_crypto", "stop_hit", -4);

  // Spread some AUTO tier wins to make the conviction-curve query have data
  for (let k = 0; k < 3; k++) push("v1", "auto", "etf_flow_reaction", "large_cap_crypto", "target_hit", 8, 0.85);
  for (let k = 0; k < 4; k++) push("v2", "auto", "etf_flow_reaction", "large_cap_crypto", "target_hit", 7, 0.85);

  return rows;
}

function insert(rows: SeedRow[]): void {
  const stmt = db().prepare(
    `INSERT INTO signal_outcomes (
       signal_id, asset_id, direction, catalyst_subtype, asset_class,
       tier, conviction,
       generated_at, horizon_hours, expires_at,
       price_at_generation, target_pct, stop_pct,
       outcome, outcome_at, price_at_outcome, realized_pct, realized_pnl_usd,
       recorded_at, framework_version
     ) VALUES (
       @signal_id, 'tok-test', 'long', @catalyst_subtype, @asset_class,
       @tier, @conviction,
       @generated_at, 48, @generated_at + 48*3600*1000,
       100, 5, 3,
       @outcome, @outcome_at, 105, @realized_pct, @realized_pnl_usd,
       @generated_at, @framework_version
     )`,
  );
  for (const r of rows) {
    const generated_at = NOW - r.daysAgo * 24 * 3600 * 1000;
    stmt.run({
      signal_id: r.signal_id,
      catalyst_subtype: r.catalyst_subtype,
      asset_class: r.asset_class,
      tier: r.tier,
      conviction: r.conviction,
      generated_at,
      outcome: r.outcome,
      outcome_at:
        r.outcome === "target_hit" || r.outcome === "stop_hit" || r.outcome === "flat"
          ? generated_at + 24 * 3600 * 1000
          : null,
      realized_pct: r.realized_pct,
      realized_pnl_usd: r.realized_pnl_usd,
      framework_version: r.framework_version,
    });
  }
}

describe("v2.1 attribution — calibration framework filtering", () => {
  let memDb: Database.Database;
  beforeEach(() => {
    memDb = new Database(":memory:");
    memDb.pragma("foreign_keys = ON");
    bootstrapSchema(memDb);
    _setDatabaseForTests(memDb);
    insert(seed());
  });
  afterEach(() => {
    _setDatabaseForTests(null);
    memDb.close();
  });

  it("hitRateByTier filters to v1 outcomes only when frameworkVersion='v1'", () => {
    const v1 = hitRateByTier({
      window_days: 30,
      now_ms: NOW,
      frameworkVersion: "v1",
    });
    const review = v1.find((r) => r.tier === "review");
    expect(review?.target_hit).toBe(6);
    expect(review?.stop_hit).toBe(4);
  });

  it("hitRateByTier filters to v2 outcomes only when frameworkVersion='v2'", () => {
    const v2 = hitRateByTier({
      window_days: 30,
      now_ms: NOW,
      frameworkVersion: "v2",
    });
    const review = v2.find((r) => r.tier === "review");
    expect(review?.target_hit).toBe(5);
    expect(review?.stop_hit).toBe(2);
  });

  it("hitRateByTier with no filter returns aggregate of both frameworks", () => {
    const all = hitRateByTier({ window_days: 30, now_ms: NOW });
    const review = all.find((r) => r.tier === "review");
    expect(review?.target_hit).toBe(11); // 6 + 5
    expect(review?.stop_hit).toBe(6); // 4 + 2
  });
});

describe("v2.1 attribution — comparison queries", () => {
  let memDb: Database.Database;
  beforeEach(() => {
    memDb = new Database(":memory:");
    memDb.pragma("foreign_keys = ON");
    bootstrapSchema(memDb);
    _setDatabaseForTests(memDb);
    insert(seed());
  });
  afterEach(() => {
    _setDatabaseForTests(null);
    memDb.close();
  });

  it("getHitRateByFrameworkAndTier returns one row per (framework, tier)", () => {
    const rows = getHitRateByFrameworkAndTier({ window_days: 30, now_ms: NOW });
    const v1Review = rows.find((r) => r.framework_version === "v1" && r.tier === "review");
    const v2Review = rows.find((r) => r.framework_version === "v2" && r.tier === "review");
    expect(v1Review).toBeDefined();
    expect(v2Review).toBeDefined();
    // v2 hit rate should be higher (5/7 vs 6/10)
    expect(v2Review!.hit_rate).toBeGreaterThan(v1Review!.hit_rate ?? 0);
  });

  it("getPnlByFrameworkAndCatalystSubtype splits PnL by (framework, subtype)", () => {
    const rows = getPnlByFrameworkAndCatalystSubtype({
      window_days: 30,
      now_ms: NOW,
    });
    const v1Earn = rows.find(
      (r) => r.framework_version === "v1" && r.catalyst_subtype === "earnings_reaction",
    );
    const v2Earn = rows.find(
      (r) => r.framework_version === "v2" && r.catalyst_subtype === "earnings_reaction",
    );
    expect(v1Earn).toBeDefined();
    expect(v2Earn).toBeDefined();
    // v1: 6 wins × 5pct − 4 losses × 3pct = 30 − 12 = 18 net realized %; pnl = 5x
    // v2: 5 × 6 − 2 × 4 = 22; pnl = 5x
    expect(v2Earn!.total_pnl_usd).toBeGreaterThan(v1Earn!.total_pnl_usd);
  });

  it("getCalibrationCurveByFramework returns binned data per framework", () => {
    const v1 = getCalibrationCurveByFramework({
      window_days: 30,
      now_ms: NOW,
      frameworkVersion: "v1",
    });
    const v2 = getCalibrationCurveByFramework({
      window_days: 30,
      now_ms: NOW,
      frameworkVersion: "v2",
    });
    // Both should have data in some bin
    expect(v1.length).toBeGreaterThan(0);
    expect(v2.length).toBeGreaterThan(0);
  });

  it("getFrameworkSummary returns top-line metrics per framework with delta", () => {
    const summary = getFrameworkSummary({ window_days: 30, now_ms: NOW });
    expect(summary.v1.sample).toBeGreaterThan(0);
    expect(summary.v2.sample).toBeGreaterThan(0);
    // v2 hit_rate higher
    expect((summary.v2.hit_rate ?? 0)).toBeGreaterThan(summary.v1.hit_rate ?? 0);
    // delta object reflects the difference
    expect(summary.delta.hit_rate).toBeGreaterThan(0);
  });

  it("framework with zero outcomes returns empty result, not error", () => {
    // No v2 in this restricted seed
    const empty = hitRateByTier({
      window_days: 30,
      now_ms: NOW,
      frameworkVersion: "nonexistent" as "v1" | "v2",
    });
    expect(empty).toEqual([]);
  });
});
