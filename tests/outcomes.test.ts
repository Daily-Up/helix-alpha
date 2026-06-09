/**
 * Part 1 regression — signal outcome tracking. Wave 2: async libSQL.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { all, get, run } from "@/lib/db/client";
import { setupMemoryDb, teardownMemoryDb } from "./db-setup";
import {
  resolveOutcome,
  type DailyKline,
  type ResolveInput,
} from "@/lib/outcomes/resolve";
import {
  insertOutcomeFromSignal,
  markOutcomeDismissed,
  insertBlockedOutcome,
  listPendingOutcomes,
  applyResolution,
  type OutcomeRow,
} from "@/lib/db/repos/outcomes";

const NOW = Date.UTC(2026, 4, 9, 12, 0, 0);

function syntheticSignal(overrides: Partial<ResolveInput["signal"]> = {}) {
  return {
    asset_id: "tok-btc",
    direction: "long" as const,
    price_at_generation: 100,
    target_pct: 5,
    stop_pct: 3,
    generated_at: NOW - 24 * 3600 * 1000,
    expires_at: NOW + 48 * 3600 * 1000,
    ...overrides,
  };
}

function klines(
  start_ms: number,
  bars: Array<[number, number, number, number]>,
): DailyKline[] {
  return bars.map((b, i) => ({
    asset_id: "tok-btc",
    date: new Date(start_ms + i * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10),
    open: b[0],
    high: b[1],
    low: b[2],
    close: b[3],
    ts_ms: start_ms + i * 24 * 3600 * 1000,
  }));
}

describe("Part 1 — resolveOutcome (pure)", () => {
  it("LONG: high touches target → target_hit label, realized = close-to-close ROI at expiry", () => {
    const r = resolveOutcome({
      signal: syntheticSignal(),
      klines: klines(NOW - 24 * 3600 * 1000, [
        [101, 103, 100, 102],
        [102, 106, 101, 105.5],
      ]),
      now: NOW + 49 * 3600 * 1000,
    });
    expect(r.outcome).toBe("target_hit");
    // Close-to-close is +5.5%, but realized is clamped to the +5% target
    // (the take-profit would have filled there). price_at_outcome keeps
    // the raw close for transparency.
    expect(r.realized_pct).toBeCloseTo(5, 1);
    expect(r.price_at_outcome).toBeCloseTo(105.5, 1);
  });

  it("LONG: low touches stop → stop_hit label, realized = close-to-close ROI at expiry", () => {
    const r = resolveOutcome({
      signal: syntheticSignal(),
      klines: klines(NOW - 24 * 3600 * 1000, [
        [100, 101, 96, 98],
      ]),
      now: NOW + 49 * 3600 * 1000,
    });
    expect(r.outcome).toBe("stop_hit");
    // Touched the stop intraday but closed at 98 → realized is -2%, not -3%.
    expect(r.realized_pct).toBeCloseTo(-2, 1);
    expect(r.price_at_outcome).toBeCloseTo(98, 1);
  });

  it("LONG: both touched same day → pessimistic stop_hit label, realized from close", () => {
    const r = resolveOutcome({
      signal: syntheticSignal(),
      klines: klines(NOW - 24 * 3600 * 1000, [
        [100, 106, 96, 102],
      ]),
      now: NOW + 49 * 3600 * 1000,
    });
    expect(r.outcome).toBe("stop_hit");
    // Both levels touched, but it closed at 102 → realized is +2%.
    expect(r.realized_pct).toBeCloseTo(2, 1);
  });

  it("LONG: neither hit, expiry passed → flat", () => {
    const r = resolveOutcome({
      signal: syntheticSignal(),
      klines: klines(NOW - 24 * 3600 * 1000, [
        [100, 103, 99, 101],
        [101, 104, 100, 102],
      ]),
      now: NOW + 49 * 3600 * 1000,
    });
    expect(r.outcome).toBe("flat");
    expect(r.realized_pct).toBeCloseTo(2, 1);
    expect(r.price_at_outcome).toBeCloseTo(102, 1);
  });

  it("LONG: neither hit, still inside horizon → pending", () => {
    const r = resolveOutcome({
      signal: syntheticSignal({
        expires_at: NOW + 100 * 3600 * 1000,
      }),
      klines: klines(NOW - 24 * 3600 * 1000, [
        [100, 103, 99, 101],
      ]),
      now: NOW + 12 * 3600 * 1000,
    });
    expect(r.outcome).toBeNull();
  });

  it("SHORT: low touches target → target_hit label, realized from close-to-close ROI", () => {
    const r = resolveOutcome({
      signal: syntheticSignal({ direction: "short" }),
      klines: klines(NOW - 24 * 3600 * 1000, [
        [100, 102, 94, 96],
      ]),
      now: NOW + 49 * 3600 * 1000,
    });
    expect(r.outcome).toBe("target_hit");
    // Short closed at 96 from 100 → +4% directional, not the +5% target.
    expect(r.realized_pct).toBeCloseTo(4, 1);
  });

  it("SHORT: high touches stop → stop_hit label, realized from close-to-close ROI", () => {
    const r = resolveOutcome({
      signal: syntheticSignal({ direction: "short" }),
      klines: klines(NOW - 24 * 3600 * 1000, [
        [100, 104, 99, 103.5],
      ]),
      now: NOW + 49 * 3600 * 1000,
    });
    expect(r.outcome).toBe("stop_hit");
    // Short closed at 103.5 → -3.5% directional, clamped to the -3% stop
    // (the stop-loss would have filled there).
    expect(r.realized_pct).toBeCloseTo(-3, 1);
  });

  it("Empty kline series with horizon expired → flat with realized_pct = 0", () => {
    const r = resolveOutcome({
      signal: syntheticSignal(),
      klines: [],
      now: NOW + 49 * 3600 * 1000,
    });
    expect(r.outcome).toBe("flat");
    expect(r.realized_pct).toBe(0);
  });

  it("Empty kline series, horizon NOT expired → pending", () => {
    const r = resolveOutcome({
      signal: syntheticSignal({ expires_at: NOW + 100 * 3600 * 1000 }),
      klines: [],
      now: NOW + 1000,
    });
    expect(r.outcome).toBeNull();
  });
});

describe("Part 1 — outcomes DB layer", () => {
  beforeEach(async () => {
    await setupMemoryDb();
  });
  afterEach(() => {
    teardownMemoryDb();
  });

  async function seedSignal(opts: {
    id: string;
    asset_id: string;
    asset_kind: string;
    asset_symbol: string;
    direction: "long" | "short";
    tier: "auto" | "review" | "info";
    confidence: number;
    catalyst_subtype: string;
    fired_at: number;
    expires_at: number;
    suggested_stop_pct: number;
    suggested_target_pct: number;
  }) {
    await run(
      `INSERT OR IGNORE INTO assets (id, symbol, name, kind, routing)
       VALUES (?, ?, ?, ?, '{}')`,
      [opts.asset_id, opts.asset_symbol, opts.asset_symbol, opts.asset_kind],
    );
    await run(
      `INSERT INTO signals (
         id, fired_at, asset_id, sodex_symbol, direction, tier, status, confidence,
         expected_horizon, suggested_stop_pct, suggested_target_pct, reasoning,
         catalyst_subtype, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, '24h', ?, ?, '', ?, ?)`,
      [
        opts.id,
        opts.fired_at,
        opts.asset_id,
        `${opts.asset_symbol}-USD`,
        opts.direction,
        opts.tier,
        opts.confidence,
        opts.suggested_stop_pct,
        opts.suggested_target_pct,
        opts.catalyst_subtype,
        opts.expires_at,
      ],
    );
  }

  it("insertOutcomeFromSignal writes a row with outcome=NULL", async () => {
    await seedSignal({
      id: "sig-1",
      asset_id: "tok-btc",
      asset_kind: "token",
      asset_symbol: "BTC",
      direction: "long",
      tier: "review",
      confidence: 0.7,
      catalyst_subtype: "etf_flow_reaction",
      fired_at: NOW,
      expires_at: NOW + 48 * 3600 * 1000,
      suggested_stop_pct: 3,
      suggested_target_pct: 5,
    });

    await insertOutcomeFromSignal({
      signal_id: "sig-1",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
    });

    const row = await get<OutcomeRow>(
      "SELECT * FROM signal_outcomes WHERE signal_id = ?",
      ["sig-1"],
    );
    expect(row).toBeDefined();
    expect(row!.outcome).toBeNull();
    expect(row!.tier).toBe("review");
    expect(row!.catalyst_subtype).toBe("etf_flow_reaction");
    expect(row!.asset_class).toBe("large_cap_crypto");
    expect(row!.price_at_generation).toBe(100);
    expect(row!.target_pct).toBe(5);
    expect(row!.stop_pct).toBe(3);
  });

  it("markOutcomeDismissed sets outcome='dismissed' immediately", async () => {
    await seedSignal({
      id: "sig-2",
      asset_id: "tok-btc",
      asset_kind: "token",
      asset_symbol: "BTC",
      direction: "long",
      tier: "review",
      confidence: 0.7,
      catalyst_subtype: "etf_flow_reaction",
      fired_at: NOW,
      expires_at: NOW + 48 * 3600 * 1000,
      suggested_stop_pct: 3,
      suggested_target_pct: 5,
    });
    await insertOutcomeFromSignal({
      signal_id: "sig-2",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
    });

    await markOutcomeDismissed("sig-2");

    const row = await get<OutcomeRow>(
      "SELECT * FROM signal_outcomes WHERE signal_id = ?",
      ["sig-2"],
    );
    expect(row!.outcome).toBe("dismissed");
    expect(row!.outcome_at).not.toBeNull();
  });

  it("insertBlockedOutcome captures a gate refusal with rule logged", async () => {
    await insertBlockedOutcome({
      signal_id: "would-have-been-sig-3",
      asset_id: "tok-trump",
      asset_class: "small_cap_crypto",
      direction: "short",
      tier: "review",
      conviction: 0.76,
      catalyst_subtype: "earnings_reaction",
      generated_at: NOW,
      horizon_hours: 48,
      expires_at: NOW + 48 * 3600 * 1000,
      price_at_generation: null,
      target_pct: 6,
      stop_pct: 4,
      rule: "earnings_reaction_on_non_corporate",
    });

    const row = await get<OutcomeRow>(
      "SELECT * FROM signal_outcomes WHERE signal_id = ?",
      ["would-have-been-sig-3"],
    );
    expect(row!.outcome).toBe("blocked");
    expect(row!.notes).toContain("earnings_reaction_on_non_corporate");
  });

  it("listPendingOutcomes returns rows where outcome IS NULL", async () => {
    await seedSignal({
      id: "pending-a",
      asset_id: "tok-btc",
      asset_kind: "token",
      asset_symbol: "BTC",
      direction: "long",
      tier: "review",
      confidence: 0.7,
      catalyst_subtype: "etf_flow_reaction",
      fired_at: NOW,
      expires_at: NOW + 48 * 3600 * 1000,
      suggested_stop_pct: 3,
      suggested_target_pct: 5,
    });
    await insertOutcomeFromSignal({
      signal_id: "pending-a",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
    });

    await seedSignal({
      id: "pending-b",
      asset_id: "tok-btc",
      asset_kind: "token",
      asset_symbol: "BTC",
      direction: "long",
      tier: "review",
      confidence: 0.7,
      catalyst_subtype: "etf_flow_reaction",
      fired_at: NOW + 1,
      expires_at: NOW + 48 * 3600 * 1000,
      suggested_stop_pct: 3,
      suggested_target_pct: 5,
    });
    await insertOutcomeFromSignal({
      signal_id: "pending-b",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
    });
    await markOutcomeDismissed("pending-b");

    const pending = await listPendingOutcomes();
    const ids = pending.map((p) => p.signal_id);
    expect(ids).toContain("pending-a");
    expect(ids).not.toContain("pending-b");
  });

  it("applyResolution writes target_hit / realized_pct / outcome_at", async () => {
    await seedSignal({
      id: "resolve-target",
      asset_id: "tok-btc",
      asset_kind: "token",
      asset_symbol: "BTC",
      direction: "long",
      tier: "auto",
      confidence: 0.8,
      catalyst_subtype: "treasury_action",
      fired_at: NOW - 24 * 3600 * 1000,
      expires_at: NOW + 24 * 3600 * 1000,
      suggested_stop_pct: 3,
      suggested_target_pct: 5,
    });
    await insertOutcomeFromSignal({
      signal_id: "resolve-target",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
    });

    await applyResolution("resolve-target", {
      outcome: "target_hit",
      outcome_at_ms: NOW,
      price_at_outcome: 105,
      realized_pct: 5,
    });

    const row = await get<OutcomeRow>(
      "SELECT * FROM signal_outcomes WHERE signal_id = ?",
      ["resolve-target"],
    );
    expect(row!.outcome).toBe("target_hit");
    expect(row!.realized_pct).toBe(5);
    expect(row!.price_at_outcome).toBe(105);
    expect(row!.outcome_at).not.toBeNull();
  });
});

// Suppress unused imports.
void all;
