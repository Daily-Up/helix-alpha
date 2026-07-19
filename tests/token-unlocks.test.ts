/**
 * Token-unlocks feature — DefiLlama extraction helpers, the token_unlocks
 * repo, and the standalone SHORT-signal generator (end-to-end against an
 * in-memory DB).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupMemoryDb, teardownMemoryDb } from "./db-setup";
import { TokenUnlocks, Signals, Outcomes } from "@/lib/db";
import type { NewTokenUnlock } from "@/lib/db";
import {
  upcomingUnlockEvents,
  eventCliffTokens,
  eventKind,
  circulatingAtNow,
} from "@/lib/unlocks/defillama";
import type { EmissionsDetail } from "@/lib/unlocks/types";
import { generateUnlockSignals } from "@/lib/trading/unlock-signals";

const HOUR = 3600 * 1000;

function fixtureDetail(nowSec: number): EmissionsDetail {
  return {
    name: "Arbitrum",
    metadata: {
      token: "arbitrum:0x912ce59144191c1204e64559fe8253a0e49e6548",
      unlockEvents: [
        // past — ignored
        {
          timestamp: nowSec - 10 * 24 * 3600,
          cliffAllocations: [{ recipient: "Team", category: "insiders", unlockType: "cliff", amount: 100 }],
          linearAllocations: [],
          summary: { totalTokensCliff: 100 },
        },
        // upcoming cliff
        {
          timestamp: nowSec + 2 * 24 * 3600,
          cliffAllocations: [
            { recipient: "Team", category: "insiders", unlockType: "cliff", amount: 56125000 },
            { recipient: "Investors", category: "privateSale", unlockType: "cliff", amount: 36520833 },
          ],
          linearAllocations: [],
          summary: { totalTokensCliff: 92645833 },
        },
        // linear-only upcoming — 0 cliff tokens, should be filtered by ingest
        {
          timestamp: nowSec + 5 * 24 * 3600,
          cliffAllocations: [],
          linearAllocations: [{ recipient: "Foundation", category: "insiders", unlockType: "linear" }],
          summary: { totalTokensCliff: 0 },
        },
      ],
    },
    documentedData: {
      data: [
        {
          label: "Team",
          data: [
            { timestamp: nowSec - 3600, unlocked: 3_000_000_000 },
            { timestamp: nowSec + 3600, unlocked: 3_100_000_000 },
          ],
        },
        {
          label: "Treasury",
          data: [{ timestamp: nowSec - 3600, unlocked: 2_000_000_000 }],
        },
      ],
    },
    categories: { noncirculating: ["Treasury"] },
    supplyMetrics: { maxSupply: 10_000_000_000 },
  };
}

describe("DefiLlama extraction helpers", () => {
  const nowSec = 1_784_476_800;
  const nowMs = nowSec * 1000;
  const detail = fixtureDetail(nowSec);

  it("upcomingUnlockEvents returns only future events, sorted", () => {
    const up = upcomingUnlockEvents(detail, nowMs);
    expect(up.length).toBe(2);
    expect(up[0].timestamp).toBeLessThan(up[1].timestamp);
  });

  it("eventCliffTokens reads summary.totalTokensCliff (falls back to allocation sum)", () => {
    const up = upcomingUnlockEvents(detail, nowMs);
    expect(eventCliffTokens(up[0])).toBe(92645833);
    // fallback path
    expect(
      eventCliffTokens({
        timestamp: 0,
        cliffAllocations: [{ recipient: "x", category: "y", unlockType: "cliff", amount: 5 }],
        linearAllocations: [],
        summary: {},
      }),
    ).toBe(5);
  });

  it("eventKind classifies cliff / linear / mixed", () => {
    const up = upcomingUnlockEvents(detail, nowMs);
    expect(eventKind(up[0])).toBe("cliff");
    expect(eventKind(up[1])).toBe("linear");
  });

  it("circulatingAtNow sums circulating tranches, excludes non-circulating", () => {
    // Team latest ≤ now = 3.0B; Treasury excluded → 3.0B (not 5.0B).
    expect(circulatingAtNow(detail, nowMs)).toBe(3_000_000_000);
  });
});

describe("token_unlocks repo", () => {
  beforeEach(async () => {
    await setupMemoryDb();
  });
  afterEach(() => teardownMemoryDb());

  it("upserts and reads back; upcomingUnlocks(tradableOnly) filters", async () => {
    const now = Date.now();
    const rows: NewTokenUnlock[] = [
      {
        id: "arbitrum-2099-01-01",
        protocol_slug: "arbitrum",
        token_id: "arbitrum:0x91",
        symbol: "ARB",
        asset_id: "tok-arb",
        sodex_symbol: "ARB-USD",
        tradable_perp: 1,
        unlock_at: now + 24 * HOUR,
        unlock_date: "2099-01-01",
        unlock_kind: "cliff",
        tokens_unlocked: 92645833,
        unlock_value_usd: 8_200_000,
        price_usd: 0.0886,
        pct_of_circulating: 1.66,
        pct_of_max_supply: 0.93,
        categories_json: "[]",
        source: "defillama",
        raw_json: "{}",
      },
      {
        id: "sometoken-2099-02-02",
        protocol_slug: "sometoken",
        token_id: null,
        symbol: "SOME",
        asset_id: null, // not in universe → not tradable
        sodex_symbol: null,
        tradable_perp: 0,
        unlock_at: now + 48 * HOUR,
        unlock_date: "2099-02-02",
        unlock_kind: "cliff",
        tokens_unlocked: 1000,
        unlock_value_usd: 100,
        price_usd: 0.1,
        pct_of_circulating: 0.01,
        pct_of_max_supply: 0.01,
        categories_json: "[]",
        source: "defillama",
        raw_json: "{}",
      },
    ];
    await TokenUnlocks.upsertUnlocks(rows);

    const all = await TokenUnlocks.upcomingUnlocks({});
    expect(all.length).toBe(2);

    const tradable = await TokenUnlocks.upcomingUnlocks({ tradableOnly: true });
    expect(tradable.length).toBe(1);
    expect(tradable[0].symbol).toBe("ARB");

    // idempotent upsert
    await TokenUnlocks.upsertUnlocks([rows[0]]);
    expect((await TokenUnlocks.upcomingUnlocks({})).length).toBe(2);
  });
});

describe("generateUnlockSignals", () => {
  beforeEach(async () => {
    await setupMemoryDb();
  });
  afterEach(() => teardownMemoryDb());

  async function seedTradableUnlock(overrides: Partial<NewTokenUnlock> = {}) {
    const now = Date.now();
    const row: NewTokenUnlock = {
      id: "arbitrum-2099-01-01",
      protocol_slug: "arbitrum",
      token_id: "arbitrum:0x91",
      symbol: "ARB", // real universe ticker → findAsset resolves (tok-arb)
      asset_id: "tok-arb",
      sodex_symbol: "ARB-USD",
      tradable_perp: 1,
      unlock_at: now + 36 * HOUR, // within default 72h lead window
      unlock_date: "2099-01-01",
      unlock_kind: "cliff",
      tokens_unlocked: 92645833,
      unlock_value_usd: 8_200_000, // above MIN_USD
      price_usd: 0.0886,
      pct_of_circulating: 1.66, // above MIN_PCT_FLOAT
      pct_of_max_supply: 0.93,
      categories_json: JSON.stringify([{ recipient: "Team", category: "insiders" }]),
      source: "defillama",
      raw_json: "{}",
      ...overrides,
    };
    await TokenUnlocks.upsertUnlocks([row]);
  }

  it("creates a SHORT signal + outcome for a large near-term unlock, idempotently", async () => {
    await seedTradableUnlock();

    const first = await generateUnlockSignals();
    expect(first.created).toBe(1);
    expect(first.by_tier.review + first.by_tier.auto).toBe(1);

    const signals = await Signals.listSignals({ status: "pending" });
    expect(signals.length).toBe(1);
    const sig = signals[0];
    expect(sig.direction).toBe("short");
    expect(sig.sodex_symbol).toBe("ARB-USD");
    expect(sig.catalyst_subtype).toBe("unlock_supply");
    expect(sig.event_chain_id).toBe("unlock:arbitrum-2099-01-01");
    expect(sig.suggested_size_usd).toBeGreaterThan(0);
    expect(sig.significance_score).toBeGreaterThan(0);

    // I-30 companion outcome exists
    expect(await Outcomes.outcomeExistsFor(sig.id)).toBe(true);

    // rerun → deduped, no new signal
    const second = await generateUnlockSignals();
    expect(second.created).toBe(0);
    expect(second.skipped_duplicate).toBe(1);
  });

  it("skips small unlocks below the threshold", async () => {
    await seedTradableUnlock({
      id: "arbitrum-2099-03-03",
      unlock_date: "2099-03-03",
      unlock_value_usd: 100_000, // below MIN_USD
      pct_of_circulating: 0.1, // below MIN_PCT_FLOAT
    });
    const res = await generateUnlockSignals();
    expect(res.created).toBe(0);
    expect(res.skipped_below_threshold).toBe(1);
  });
});
