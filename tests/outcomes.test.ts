/**
 * Part 1 regression — signal outcome tracking.
 *
 * Two layers:
 *   - `resolveOutcome(signal, klines)` — pure function that walks a price
 *     series and decides target_hit / stop_hit / flat / pending. No DB.
 *   - DB write paths: signal-fire creates an outcome row (atomic); dismiss
 *     hook updates outcome='dismissed'; gate-refusal hook inserts
 *     outcome='blocked'; resolution job updates pending rows.
 *
 * The pure layer is the focus — it's where the algorithmic decisions
 * live. The DB layer is exercised end-to-end in the integration tests
 * via in-memory better-sqlite3.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapSchema,
  _setDatabaseForTests,
  db,
} from "@/lib/db/client";
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

// ────────────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 4, 9, 12, 0, 0); // 2026-05-09 12:00 UTC

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

/** Build a kline series day-by-day starting at `start_ms`, interval 1d.
 *  Each entry is a tuple [open,high,low,close]. */
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

// ────────────────────────────────────────────────────────────────────────
// Pure resolveOutcome
// ────────────────────────────────────────────────────────────────────────

describe("Part 1 — resolveOutcome (pure)", () => {
  it("LONG: high crosses target before stop → target_hit, realized ≈ +target_pct", () => {
    // Day 1: close 102 (no hit). Day 2: high 106 (target 105 hit), low 101.
    const r = resolveOutcome({
      signal: syntheticSignal(),
      klines: klines(NOW - 24 * 3600 * 1000, [
        [101, 103, 100, 102],
        [102, 106, 101, 105.5],
      ]),
      now: NOW + 49 * 3600 * 1000,
    });
    expect(r.outcome).toBe("target_hit");
    expect(r.realized_pct).toBeCloseTo(5, 1);
    expect(r.price_at_outcome).toBeCloseTo(105, 1);
  });

  it("LONG: low crosses stop before target → stop_hit, realized ≈ -stop_pct", () => {
    // Day 1: low 96 (stop 97 hit).
    const r = resolveOutcome({
      signal: syntheticSignal(),
      klines: klines(NOW - 24 * 3600 * 1000, [
        [100, 101, 96, 98], // low 96 < stop_price 97 → stop hit
      ]),
      now: NOW + 49 * 3600 * 1000,
    });
    expect(r.outcome).toBe("stop_hit");
    expect(r.realized_pct).toBeCloseTo(-3, 1);
  });

  it("LONG: both hit same day → pessimistic stop_hit (we assume stop fired first)", () => {
    const r = resolveOutcome({
      signal: syntheticSignal(),
      klines: klines(NOW - 24 * 3600 * 1000, [
        [100, 106, 96, 102], // both target (105) and stop (97) inside the day
      ]),
      now: NOW + 49 * 3600 * 1000,
    });
    expect(r.outcome).toBe("stop_hit");
  });

  it("LONG: neither hit, expiry passed → flat with realized_pct from final close", () => {
    // Final close 102 → realized +2%
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

  it("LONG: neither hit, still inside horizon → pending (retry next run)", () => {
    const r = resolveOutcome({
      signal: syntheticSignal({
        expires_at: NOW + 100 * 3600 * 1000, // far future
      }),
      klines: klines(NOW - 24 * 3600 * 1000, [
        [100, 103, 99, 101],
      ]),
      now: NOW + 12 * 3600 * 1000,
    });
    expect(r.outcome).toBeNull();
  });

  it("SHORT: low crosses target (price falling) → target_hit", () => {
    // Short on 100, target 95 (down 5%), stop 103 (up 3%).
    // Day 1: low 94 → target hit at 95.
    const r = resolveOutcome({
      signal: syntheticSignal({ direction: "short" }),
      klines: klines(NOW - 24 * 3600 * 1000, [
        [100, 102, 94, 96], // low 94 < target 95
      ]),
      now: NOW + 49 * 3600 * 1000,
    });
    expect(r.outcome).toBe("target_hit");
    expect(r.realized_pct).toBeCloseTo(5, 1); // profit on a short = -% move, here +5
  });

  it("SHORT: high crosses stop (price rising) → stop_hit", () => {
    // Short on 100, stop 103 (up 3%).
    // Day 1: high 104 → stop hit.
    const r = resolveOutcome({
      signal: syntheticSignal({ direction: "short" }),
      klines: klines(NOW - 24 * 3600 * 1000, [
        [100, 104, 99, 103.5],
      ]),
      now: NOW + 49 * 3600 * 1000,
    });
    expect(r.outcome).toBe("stop_hit");
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

  it("Empty kline series, horizon NOT expired → pending (price feed unavailable, retry)", () => {
    const r = resolveOutcome({
      signal: syntheticSignal({ expires_at: NOW + 100 * 3600 * 1000 }),
      klines: [],
      now: NOW + 1000,
    });
    expect(r.outcome).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// DB layer: insert / dismiss / block / list-pending / apply-resolution
// ────────────────────────────────────────────────────────────────────────

describe("Part 1 — outcomes DB layer", () => {
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

  /** Insert the assets + signal rows the outcomes test depends on. */
  function seedSignal(opts: {
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
    db()
      .prepare(
        `INSERT OR IGNORE INTO assets (id, symbol, name, kind, routing)
         VALUES (?, ?, ?, ?, '{}')`,
      )
      .run(opts.asset_id, opts.asset_symbol, opts.asset_symbol, opts.asset_kind);
    db()
      .prepare(
        `INSERT INTO signals (
           id, fired_at, asset_id, sodex_symbol, direction, tier, status, confidence,
           expected_horizon, suggested_stop_pct, suggested_target_pct, reasoning,
           catalyst_subtype, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, '24h', ?, ?, '', ?, ?)`,
      )
      .run(
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
      );
  }

  it("insertOutcomeFromSignal writes a row with outcome=NULL", () => {
    seedSignal({
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

    insertOutcomeFromSignal({
      signal_id: "sig-1",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
    });

    const row = db()
      .prepare<[string], OutcomeRow>(
        "SELECT * FROM signal_outcomes WHERE signal_id = ?",
      )
      .get("sig-1");
    expect(row).toBeDefined();
    expect(row!.outcome).toBeNull();
    expect(row!.tier).toBe("review");
    expect(row!.catalyst_subtype).toBe("etf_flow_reaction");
    expect(row!.asset_class).toBe("large_cap_crypto");
    expect(row!.price_at_generation).toBe(100);
    expect(row!.target_pct).toBe(5);
    expect(row!.stop_pct).toBe(3);
  });

  it("markOutcomeDismissed sets outcome='dismissed' immediately", () => {
    seedSignal({
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
    insertOutcomeFromSignal({
      signal_id: "sig-2",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
    });

    markOutcomeDismissed("sig-2");

    const row = db()
      .prepare<[string], OutcomeRow>(
        "SELECT * FROM signal_outcomes WHERE signal_id = ?",
      )
      .get("sig-2");
    expect(row!.outcome).toBe("dismissed");
    expect(row!.outcome_at).not.toBeNull();
  });

  it("insertBlockedOutcome captures a gate refusal with rule logged", () => {
    insertBlockedOutcome({
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

    const row = db()
      .prepare<[string], OutcomeRow>(
        "SELECT * FROM signal_outcomes WHERE signal_id = ?",
      )
      .get("would-have-been-sig-3");
    expect(row!.outcome).toBe("blocked");
    expect(row!.notes).toContain("earnings_reaction_on_non_corporate");
  });

  it("listPendingOutcomes returns rows where outcome IS NULL", () => {
    seedSignal({
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
    insertOutcomeFromSignal({
      signal_id: "pending-a",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
    });

    seedSignal({
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
    insertOutcomeFromSignal({
      signal_id: "pending-b",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
    });
    markOutcomeDismissed("pending-b");

    const pending = listPendingOutcomes();
    const ids = pending.map((p) => p.signal_id);
    expect(ids).toContain("pending-a");
    expect(ids).not.toContain("pending-b");
  });

  it("applyResolution writes target_hit / realized_pct / outcome_at", () => {
    seedSignal({
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
    insertOutcomeFromSignal({
      signal_id: "resolve-target",
      asset_class: "large_cap_crypto",
      price_at_generation: 100,
    });

    applyResolution("resolve-target", {
      outcome: "target_hit",
      outcome_at_ms: NOW,
      price_at_outcome: 105,
      realized_pct: 5,
    });

    const row = db()
      .prepare<[string], OutcomeRow>(
        "SELECT * FROM signal_outcomes WHERE signal_id = ?",
      )
      .get("resolve-target");
    expect(row!.outcome).toBe("target_hit");
    expect(row!.realized_pct).toBe(5);
    expect(row!.price_at_outcome).toBe(105);
    expect(row!.outcome_at).not.toBeNull();
  });
});
