/**
 * Token-unlocks feature — DefiLlama extraction helpers, the token_unlocks
 * repo, and the standalone SHORT-signal generator (end-to-end against an
 * in-memory DB).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupMemoryDb, teardownMemoryDb } from "./db-setup";
import { TokenUnlocks } from "@/lib/db";
import type { NewTokenUnlock } from "@/lib/db";
import {
  upcomingUnlockEvents,
  eventCliffTokens,
  eventKind,
  circulatingAtNow,
} from "@/lib/unlocks/defillama";
import type { EmissionsDetail } from "@/lib/unlocks/types";
import {
  computeUnlockTradePlan,
  classifyRecipient,
  type UnlockPlanInput,
} from "@/lib/unlocks/plan";

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
        unlock_vs_volume: 0.5,
        float_pct: 66,
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
        unlock_vs_volume: null,
        float_pct: null,
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

describe("computeUnlockTradePlan (pure)", () => {
  const DAY = 24 * HOUR;
  const base = (o: Partial<UnlockPlanInput> = {}): UnlockPlanInput => ({
    unlock_at: Date.now() + 20 * DAY,
    unlock_kind: "cliff",
    unlock_value_usd: 8_000_000,
    pct_of_circulating: 1.66,
    categories_json: JSON.stringify([{ recipient: "Team", category: "insiders" }]),
    tradable_perp: 1,
    sodex_symbol: "ARB-USD",
    ...o,
  });

  it("classifyRecipient maps DefiLlama categories", () => {
    expect(classifyRecipient(JSON.stringify([{ category: "insiders" }]))).toBe("team");
    expect(classifyRecipient(JSON.stringify([{ category: "privateSale" }]))).toBe("investor");
    expect(
      classifyRecipient(JSON.stringify([{ category: "insiders" }, { category: "privateSale" }])),
    ).toBe("mixed");
    expect(classifyRecipient(JSON.stringify([{ category: "airdrop" }]))).toBe("other");
  });

  it("team cliff ≥1% of float on a perp is eligible with a plan", () => {
    const p = computeUnlockTradePlan(base());
    expect(p.eligible).toBe(true);
    expect(p.recipientClass).toBe("team");
    expect(p.materiality).toBe("modest");
    expect(p.entryLeadDays).toBe(7);
    expect(p.entryAt).toBeLessThan(p.coverAt);
    expect(p.conviction).toBeGreaterThan(0.4);
  });

  it("skips community / small / non-perp unlocks", () => {
    expect(computeUnlockTradePlan(base({ categories_json: JSON.stringify([{ category: "airdrop" }]) })).eligible).toBe(false);
    expect(computeUnlockTradePlan(base({ pct_of_circulating: 0.3 })).eligible).toBe(false);
    expect(computeUnlockTradePlan(base({ tradable_perp: 0, sodex_symbol: null })).eligible).toBe(false);
  });

  it("materiality scales entry lead + conviction; huge > modest", () => {
    const modest = computeUnlockTradePlan(base({ pct_of_circulating: 2 }));
    const huge = computeUnlockTradePlan(base({ pct_of_circulating: 12 }));
    expect(huge.materiality).toBe("huge");
    expect(huge.entryLeadDays).toBe(14);
    expect(huge.conviction).toBeGreaterThan(modest.conviction);
    expect(huge.targetPct).toBeGreaterThan(modest.targetPct);
  });

  it("SoSoValue amplifiers raise conviction (thin float + high vs-volume)", () => {
    const plain = computeUnlockTradePlan(base({ pct_of_circulating: 2 }));
    const amped = computeUnlockTradePlan(
      base({ pct_of_circulating: 2, unlock_vs_volume: 2, float_pct: 20 }),
    );
    expect(amped.conviction).toBeGreaterThan(plain.conviction);
    expect(amped.amplifiers.length).toBe(2);
  });

  it("phase reflects the entry window relative to now", () => {
    const now = Date.now();
    // far out → watching
    expect(computeUnlockTradePlan(base({ unlock_at: now + 20 * DAY }), now).phase).toBe("watching");
    // inside the 7d window → entry (armed)
    expect(computeUnlockTradePlan(base({ unlock_at: now + 3 * DAY }), now).phase).toBe("entry");
    // ineligible → ineligible regardless of timing
    expect(
      computeUnlockTradePlan(base({ unlock_at: now + 3 * DAY, pct_of_circulating: 0.2 }), now).phase,
    ).toBe("ineligible");
  });
});
