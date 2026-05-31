/**
 * Part 2 regression — calibration dashboard SQL aggregates.
 *
 * Seeds 50 synthetic outcome rows covering multiple tiers, subtypes,
 * outcomes, and asset classes. Asserts each panel's query returns the
 * right aggregates.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "@/lib/db/client";
import {
  hitRateByTier,
  hitRateByCatalystSubtype,
  convictionCalibrationCurve,
  pnlBySubtypeAndAssetClass,
  topWinnersAndLosers,
} from "@/lib/queries/calibration";
import { setupMemoryDb, teardownMemoryDb } from "./db-setup";

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

async function insertRows(rows: SeedRow[]): Promise<void> {
  const sql = `INSERT INTO signal_outcomes (
     signal_id, asset_id, direction, catalyst_subtype, asset_class,
     tier, conviction,
     generated_at, horizon_hours, expires_at,
     price_at_generation, target_pct, stop_pct,
     outcome, outcome_at, price_at_outcome, realized_pct, realized_pnl_usd,
     recorded_at
   ) VALUES (?, 'tok-test', 'long', ?, ?, ?, ?, ?, 48, ?, 100, 5, 3, ?, ?, 105, ?, ?, ?)`;
  for (const r of rows) {
    const outcome_at =
      r.outcome === "target_hit" ||
      r.outcome === "stop_hit" ||
      r.outcome === "flat"
        ? r.generated_at + 24 * 3600 * 1000
        : null;
    await run(sql, [
      r.signal_id,
      r.catalyst_subtype,
      r.asset_class,
      r.tier,
      r.conviction,
      r.generated_at,
      r.generated_at + 48 * 3600 * 1000,
      r.outcome,
      outcome_at,
      r.realized_pct,
      r.realized_pnl_usd,
      r.generated_at,
    ]);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────

describe("Part 2 — calibration queries", () => {
  beforeEach(async () => {
    await setupMemoryDb();
    await insertRows(seedRows());
  });
  afterEach(() => teardownMemoryDb());

  // Panel 1
  it("hitRateByTier — 30d window, AUTO has 5w/2l/1f, REVIEW has 11w/6l/3f", async () => {
    const rows = await hitRateByTier({ window_days: 30, now_ms: NOW });
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

  it("hitRateByTier — narrower 7d window returns smaller sample", async () => {
    const rows = await hitRateByTier({ window_days: 7, now_ms: NOW });
    const review = rows.find((r) => r.tier === "review");
    expect(review!.sample).toBeLessThan(20);
  });

  // Panel 2
  it("hitRateByCatalystSubtype — earnings_reaction has 5w/2l/1f over 8", async () => {
    const rows = await hitRateByCatalystSubtype({
      window_days: 90,
      now_ms: NOW,
    });
    const er = rows.find((r) => r.catalyst_subtype === "earnings_reaction");
    expect(er).toBeDefined();
    expect(er!.sample).toBe(8);
    expect(er!.target_hit).toBe(5);
    expect(er!.mean_realized_pct).toBeCloseTo(2.06, 1);
  });

  it("hitRateByCatalystSubtype — drops subtypes with sample < 5", async () => {
    await run(
      `INSERT INTO signal_outcomes (
         signal_id, asset_id, direction, catalyst_subtype, asset_class,
         tier, conviction, generated_at, horizon_hours, expires_at,
         target_pct, stop_pct, outcome, realized_pct, recorded_at
       ) VALUES ('one-off', 'tok-test', 'long', 'rare_subtype', 'x', 'info', 0.5, ?, 24, ?, 5, 3, 'flat', 0, ?)`,
      [NOW, NOW + 24 * 3600 * 1000, NOW],
    );
    const rows = await hitRateByCatalystSubtype({
      window_days: 90,
      now_ms: NOW,
    });
    expect(rows.find((r) => r.catalyst_subtype === "rare_subtype")).toBeUndefined();
  });

  // Panel 3
  it("convictionCalibrationCurve — bins are 10-point ranges", async () => {
    const bins = await convictionCalibrationCurve({
      window_days: 90,
      now_ms: NOW,
    });
    const b80 = bins.find((b) => b.bin_start === 80);
    expect(b80).toBeDefined();
    expect(b80!.sample).toBe(8);
    expect(b80!.hit_rate).toBeCloseTo(5 / 8, 2);

    // Calibration: 0.85 stated conviction vs 0.625 realized hit rate
    // → over-confident by ~0.22. Test that the metadata is exposed.
    expect(b80!.mean_conviction).toBeCloseTo(0.83, 1);
  });

  it("convictionCalibrationCurve — empty bins are not returned", async () => {
    const bins = await convictionCalibrationCurve({
      window_days: 90,
      now_ms: NOW,
    });
    expect(bins.find((b) => b.bin_start === 0)).toBeUndefined();
    expect(bins.find((b) => b.bin_start === 10)).toBeUndefined();
    expect(bins.find((b) => b.bin_start === 20)).toBeUndefined();
  });

  // Panel 4
  it("pnlBySubtypeAndAssetClass — earnings_reaction × crypto_adjacent_equity with mean ~2.06", async () => {
    const rows = await pnlBySubtypeAndAssetClass({
      window_days: 90,
      now_ms: NOW,
    });
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
  it("topWinnersAndLosers — best are target_hit rows, worst are stop_hit", async () => {
    const r = await topWinnersAndLosers({
      limit: 5,
      window_days: 90,
      now_ms: NOW,
    });
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
