/**
 * Part 2 regression — calibration dashboard SQL aggregates.
 *
 * Seeds 50 synthetic outcome rows covering multiple tiers, subtypes,
 * outcomes, and asset classes. Asserts each panel's query returns the
 * right aggregates.
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
  hitRateByCatalystSubtype,
  convictionCalibrationCurve,
  pnlBySubtypeAndAssetClass,
  topWinnersAndLosers,
} from "@/lib/queries/calibration";

interface SeedRow {
  signal_id: string;
  tier: "auto" | "review" | "info";
  conviction: number;
  catalyst_subtype: string;
  asset_class: string;
  outcome: string;
  realized_pct: number | null;
  realized_pnl_usd: number | null;
  generated_at: number;
}

const NOW = Date.UTC(2026, 4, 9, 12, 0, 0);

/**
 * 50-row mix covering:
 *   - tiers: auto/review/info
 *   - subtypes: earnings_reaction, etf_flow_reaction, whale_flow,
 *               regulatory_statement
 *   - asset classes: large_cap_crypto, mid_cap_crypto, crypto_adjacent_equity
 *   - outcomes: target_hit, stop_hit, flat, dismissed, blocked
 *   - convictions spanning [0.30, 0.95]
 *   - generated_at spread across the last 30 days for time-window queries
 */
function seedRows(): SeedRow[] {
  const rows: SeedRow[] = [];
  let i = 0;
  const push = (
    tier: "auto" | "review" | "info",
    conviction: number,
    sub: string,
    cls: string,
    outcome: string,
    realized: number | null,
    daysAgo: number,
  ) => {
    rows.push({
      signal_id: `sig-${i++}`,
      tier,
      conviction,
      catalyst_subtype: sub,
      asset_class: cls,
      outcome,
      realized_pct: realized,
      realized_pnl_usd: realized != null ? realized * 5 : null, // size 500
      generated_at: NOW - daysAgo * 24 * 3600 * 1000,
    });
  };

  // AUTO tier — 8 rows: 5 wins, 2 losses, 1 flat
  for (let k = 0; k < 5; k++) push("auto", 0.85, "earnings_reaction", "crypto_adjacent_equity", "target_hit", 6, k);
  for (let k = 0; k < 2; k++) push("auto", 0.82, "earnings_reaction", "crypto_adjacent_equity", "stop_hit", -7, k + 5);
  push("auto", 0.80, "earnings_reaction", "crypto_adjacent_equity", "flat", 0.5, 7);

  // REVIEW tier — 20 rows: mixed
  for (let k = 0; k < 8; k++) push("review", 0.65, "etf_flow_reaction", "large_cap_crypto", "target_hit", 4, k);
  for (let k = 0; k < 6; k++) push("review", 0.60, "etf_flow_reaction", "large_cap_crypto", "stop_hit", -3, k + 8);
  for (let k = 0; k < 3; k++) push("review", 0.55, "whale_flow", "mid_cap_crypto", "flat", 0.2, k + 14);
  for (let k = 0; k < 3; k++) push("review", 0.70, "whale_flow", "mid_cap_crypto", "target_hit", 5, k + 17);

  // INFO tier — 10 rows: most flat (low conviction → small directional bias)
  for (let k = 0; k < 4; k++) push("info", 0.40, "regulatory_statement", "large_cap_crypto", "target_hit", 1.5, k);
  for (let k = 0; k < 4; k++) push("info", 0.38, "regulatory_statement", "large_cap_crypto", "flat", 0.1, k + 4);
  for (let k = 0; k < 2; k++) push("info", 0.35, "regulatory_statement", "large_cap_crypto", "stop_hit", -2, k + 8);

  // Dismissed (no outcome math) — 6 rows
  for (let k = 0; k < 6; k++) push("review", 0.55, "treasury_action", "large_cap_crypto", "dismissed", null, k);

  // Blocked (gate caught) — 6 rows
  for (let k = 0; k < 6; k++) push("info", 0.50, "earnings_reaction", "small_cap_crypto", "blocked", null, k);

  return rows;
}

function insertRows(rows: SeedRow[]): void {
  // Need parent assets + signal stubs because applyResolution joins on
  // signals.suggested_size_usd. Easier: insert rows directly into
  // signal_outcomes (we're testing queries, not the DB integrity layer).
  const stmt = db().prepare(
    `INSERT INTO signal_outcomes (
       signal_id, asset_id, direction, catalyst_subtype, asset_class,
       tier, conviction,
       generated_at, horizon_hours, expires_at,
       price_at_generation, target_pct, stop_pct,
       outcome, outcome_at, price_at_outcome, realized_pct, realized_pnl_usd,
       recorded_at
     ) VALUES (
       @signal_id, 'tok-test', 'long', @catalyst_subtype, @asset_class,
       @tier, @conviction,
       @generated_at, 48, @generated_at + 48*3600*1000,
       100, 5, 3,
       @outcome, @outcome_at, 105, @realized_pct, @realized_pnl_usd,
       @generated_at
     )`,
  );
  for (const r of rows) {
    stmt.run({
      signal_id: r.signal_id,
      catalyst_subtype: r.catalyst_subtype,
      asset_class: r.asset_class,
      tier: r.tier,
      conviction: r.conviction,
      generated_at: r.generated_at,
      outcome: r.outcome,
      outcome_at:
        r.outcome === "target_hit" || r.outcome === "stop_hit" || r.outcome === "flat"
          ? r.generated_at + 24 * 3600 * 1000
          : null,
      realized_pct: r.realized_pct,
      realized_pnl_usd: r.realized_pnl_usd,
    });
  }
}

// ────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────

describe("Part 2 — calibration queries", () => {
  let memDb: Database.Database;

  beforeEach(() => {
    memDb = new Database(":memory:");
    memDb.pragma("foreign_keys = ON");
    bootstrapSchema(memDb);
    _setDatabaseForTests(memDb);
    insertRows(seedRows());
  });

  afterEach(() => {
    _setDatabaseForTests(null);
    memDb.close();
  });

  // Panel 1
  it("hitRateByTier — 30d window, AUTO has 5w/2l/1f, REVIEW has 11w/6l/3f", () => {
    const rows = hitRateByTier({ window_days: 30, now_ms: NOW });
    const auto = rows.find((r) => r.tier === "auto")!;
    expect(auto.target_hit).toBe(5);
    expect(auto.stop_hit).toBe(2);
    expect(auto.flat).toBe(1);
    expect(auto.sample).toBe(8);

    const review = rows.find((r) => r.tier === "review")!;
    expect(review.target_hit).toBe(11);
    expect(review.stop_hit).toBe(6);
    expect(review.flat).toBe(3);
    expect(review.sample).toBe(20);

    const info = rows.find((r) => r.tier === "info")!;
    expect(info.target_hit).toBe(4);
    expect(info.flat).toBe(4);
    expect(info.stop_hit).toBe(2);
  });

  it("hitRateByTier — narrower 7d window returns smaller sample", () => {
    const rows = hitRateByTier({ window_days: 7, now_ms: NOW });
    const review = rows.find((r) => r.tier === "review");
    // We seeded review rows from daysAgo=0..19, so 7d only catches 0..6.
    expect(review!.sample).toBeLessThan(20);
  });

  // Panel 2
  it("hitRateByCatalystSubtype — earnings_reaction has 5w/2l/1f over 8 (n>=5 passes filter)", () => {
    const rows = hitRateByCatalystSubtype({ window_days: 90, now_ms: NOW });
    const er = rows.find((r) => r.catalyst_subtype === "earnings_reaction");
    expect(er).toBeDefined();
    expect(er!.sample).toBe(8);
    expect(er!.target_hit).toBe(5);
    // mean realized: (6*5 + (-7)*2 + 0.5)/8 = 16.5/8 = 2.0625
    expect(er!.mean_realized_pct).toBeCloseTo(2.06, 1);
  });

  it("hitRateByCatalystSubtype — drops subtypes with sample < 5", () => {
    // We seeded 0 of any subtype with n<5 in this fixture, but the filter
    // should be present. Insert a spurious row for a never-seen subtype:
    db()
      .prepare(
        `INSERT INTO signal_outcomes (
           signal_id, asset_id, direction, catalyst_subtype, asset_class,
           tier, conviction, generated_at, horizon_hours, expires_at,
           target_pct, stop_pct, outcome, realized_pct, recorded_at
         ) VALUES ('one-off', 'tok-test', 'long', 'rare_subtype', 'x', 'info', 0.5, ?, 24, ?, 5, 3, 'flat', 0, ?)`,
      )
      .run(NOW, NOW + 24 * 3600 * 1000, NOW);
    const rows = hitRateByCatalystSubtype({ window_days: 90, now_ms: NOW });
    expect(rows.find((r) => r.catalyst_subtype === "rare_subtype")).toBeUndefined();
  });

  // Panel 3
  it("convictionCalibrationCurve — bins are 10-point ranges, hit_rate per bin", () => {
    const bins = convictionCalibrationCurve({ window_days: 90, now_ms: NOW });
    // 80-90 bin: 8 rows (auto), 5 wins / 2 losses / 1 flat → hit_rate = 5/8 = 0.625
    const b80 = bins.find((b) => b.bin_start === 80);
    expect(b80).toBeDefined();
    expect(b80!.sample).toBe(8);
    expect(b80!.hit_rate).toBeCloseTo(5 / 8, 2);

    // Calibration: 0.85 stated conviction vs 0.625 realized hit rate
    // → over-confident by ~0.22. Test that the metadata is exposed.
    expect(b80!.mean_conviction).toBeCloseTo(0.83, 1);
  });

  it("convictionCalibrationCurve — empty bins are not returned", () => {
    const bins = convictionCalibrationCurve({ window_days: 90, now_ms: NOW });
    // We didn't seed anything in 0-10, 10-20, 20-30 ranges.
    expect(bins.find((b) => b.bin_start === 0)).toBeUndefined();
    expect(bins.find((b) => b.bin_start === 10)).toBeUndefined();
    expect(bins.find((b) => b.bin_start === 20)).toBeUndefined();
  });

  // Panel 4
  it("pnlBySubtypeAndAssetClass — earnings_reaction × crypto_adjacent_equity exists with mean ~2.06", () => {
    const rows = pnlBySubtypeAndAssetClass({ window_days: 90, now_ms: NOW });
    const cell = rows.find(
      (r) =>
        r.catalyst_subtype === "earnings_reaction" &&
        r.asset_class === "crypto_adjacent_equity",
    );
    expect(cell).toBeDefined();
    expect(cell!.sample).toBe(8);
    expect(cell!.mean_realized_pct).toBeCloseTo(2.06, 1);
  });

  // Panel 5
  it("topWinnersAndLosers — best are target_hit rows, worst are stop_hit", () => {
    const r = topWinnersAndLosers({ limit: 5, window_days: 90, now_ms: NOW });
    expect(r.winners.length).toBeGreaterThan(0);
    expect(r.losers.length).toBeGreaterThan(0);
    // All winners should have realized_pct > 0
    expect(r.winners.every((w) => (w.realized_pct ?? 0) > 0)).toBe(true);
    // All losers should have realized_pct < 0
    expect(r.losers.every((l) => (l.realized_pct ?? 0) < 0)).toBe(true);
    // Top winner is one of the AUTO earnings target_hit rows (+6%)
    expect(r.winners[0].realized_pct).toBeCloseTo(6, 1);
    // Worst loser is the AUTO earnings stop_hit (-7%)
    expect(r.losers[0].realized_pct).toBeCloseTo(-7, 1);
  });
});
