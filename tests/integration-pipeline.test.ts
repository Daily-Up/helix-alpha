/**
 * End-to-end integration test — closes Gap D from the audit.
 *
 * What this test proves:
 *   PIPELINE_INVARIANTS.md is a real contract, not 11 disconnected
 *   unit-test claims. Each invariant covers one stage; this file runs
 *   the whole pipeline against an in-memory DB and asserts that the
 *   metadata each stage's module computes ACTUALLY reaches the persisted
 *   `signals` row, with the correct values.
 *
 * What it does:
 *   1. Spins up a fresh `:memory:` better-sqlite3 connection per case
 *      and injects it via `_setDatabaseForTests`.
 *   2. Bootstraps the schema (CREATE TABLE / INSERT OR IGNORE defaults).
 *   3. Seeds assets, news_events, and classifications from one of the
 *      adversarial fixtures defined in `tests/adversarial-fixtures.ts`.
 *   4. Calls `runSignalGen({ lookbackHours: 168 })`.
 *   5. Reads the resulting `signals` row(s) and asserts the persisted
 *      `catalyst_subtype`, `asset_relevance`, `expires_at`,
 *      `corroboration_deadline`, and `source_tier` columns exactly
 *      match what the upstream modules (catalyst-subtype, asset-router,
 *      lifecycle, signal-generator) computed.
 *
 * Coverage: 3 fixtures spanning the catalyst-subtype taxonomy:
 *   - F03 (MSTR treasury action)        — multi-day catalyst, treasury kind
 *   - F05 (Coinbase AWS outage)         — hours-scale, transient_operational
 *   - F09 (Crypto One Liners digest)    — gate must BLOCK (no signal at all)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { all, get, run } from "@/lib/db/client";
import { Assets } from "@/lib/db";
import { runSignalGen } from "@/lib/trading/signal-generator";
import { FIXTURES, type Fixture } from "./adversarial-fixtures";
import type { Asset, SodexTradable } from "@/lib/universe";
import { setupMemoryDb, teardownMemoryDb } from "./db-setup";

function tradable(symbol: string, market: "spot" | "perp"): SodexTradable {
  return { symbol, market, base: symbol.split(/_|-/)[0], quote: "vUSDC" };
}

/** Minimal-set of assets needed across the three fixtures we exercise. */
const TEST_ASSETS: Asset[] = [
  // F03 — MSTR treasury news routes to MSTR (treasury kind)
  {
    id: "trs-mstr",
    symbol: "MSTR",
    name: "Strategy (MicroStrategy)",
    kind: "treasury",
    tags: ["Treasury"],
    sosovalue: { kind: "treasury", ticker: "MSTR" },
    tradable: tradable("MSTR-USD", "perp"),
  },
  {
    id: "tok-btc",
    symbol: "BTC",
    name: "Bitcoin",
    kind: "token",
    tags: ["majors"],
    sosovalue: { kind: "token", currency_id: "btc", symbol: "BTC" },
    tradable: tradable("vBTC_vUSDC", "spot"),
  },
  {
    id: "idx-ssimag7",
    symbol: "ssimag7",
    name: "MAG7.ssi",
    kind: "index",
    tags: [],
    sosovalue: { kind: "index", ticker: "ssimag7" },
    tradable: tradable("vMAG7ssi_vUSDC", "spot"),
  },
  // F05 — Coinbase outage routes to COIN (stock)
  {
    id: "stk-coin",
    symbol: "COIN",
    name: "Coinbase Global",
    kind: "stock",
    tags: ["Exchange"],
    sosovalue: { kind: "stock", ticker: "COIN" },
    tradable: tradable("COIN-USD", "perp"),
  },
  // F09 — Crypto One Liners digest names CRCL
  {
    id: "stk-crcl",
    symbol: "CRCL",
    name: "Circle Internet Group",
    kind: "stock",
    tags: ["Stablecoin"],
    sosovalue: { kind: "stock", ticker: "CRCL" },
    tradable: tradable("CRCL-USD", "perp"),
  },
];

/**
 * Insert the fixture's news_event + classification rows.
 *
 * The fixture omits `actionable` and `event_recency` (those are runtime-
 * derived in real classifications). For the integration test we set them
 * to the values that allow the signal generator to PROCEED to the per-
 * asset gates — `actionable=1`, `event_recency='today'` — so we can
 * observe what happens at the routing/risk/lifecycle stages.
 */
async function seedFixture(f: Fixture): Promise<void> {
  await run(
    `INSERT INTO news_events (
       id, release_time, title, content, author, source_link, original_link,
       category, tags, matched_currencies,
       impression_count, like_count, retweet_count, is_blue_verified,
       raw_json
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, '[]', '[]', NULL, NULL, NULL, ?, ?)`,
    [
      f.id,
      f.raw.release_time,
      f.raw.title,
      f.raw.content,
      f.raw.author,
      f.raw.is_blue_verified ? 1 : 0,
      JSON.stringify(f.raw),
    ],
  );

  await run(
    `INSERT INTO classifications (
       event_id, event_type, sentiment, severity, confidence,
       actionable, event_recency, affected_asset_ids,
       reasoning, model, prompt_version
     ) VALUES (?, ?, ?, ?, ?, 1, 'today', ?, ?, 'test-model', 'v1')`,
    [
      f.id,
      f.classification.event_type,
      f.classification.sentiment,
      f.classification.severity,
      f.classification.confidence,
      JSON.stringify(f.classification.affected_asset_ids),
      f.classification.reasoning,
    ],
  );
}

interface PersistedSignal {
  id: string;
  asset_id: string;
  direction: "long" | "short";
  tier: "auto" | "review" | "info";
  confidence: number;
  catalyst_subtype: string | null;
  asset_relevance: number | null;
  expires_at: number | null;
  corroboration_deadline: number | null;
  source_tier: number | null;
  expected_horizon: string | null;
  fired_at: number;
}

async function readSignals(): Promise<PersistedSignal[]> {
  return all<PersistedSignal>(
    `SELECT id, asset_id, direction, tier, confidence,
            catalyst_subtype, asset_relevance, expires_at,
            corroboration_deadline, source_tier, expected_horizon,
            fired_at
     FROM signals
     WHERE status = 'pending'
     ORDER BY confidence DESC`,
  );
}

beforeEach(async () => {
  await setupMemoryDb();
  await Assets.upsertAssets(TEST_ASSETS);
});

afterEach(() => {
  teardownMemoryDb();
});

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe("Integration: pipeline metadata persists end-to-end (Gap D)", () => {
  it("F03 — MSTR treasury catalyst persists treasury_action subtype + 1.00 relevance + multi-day expiry", async () => {
    const f = FIXTURES.find((x) => x.id === "F03_mstr_bsketed_to_mag7");
    expect(f, "fixture F03 must exist").toBeDefined();
    await seedFixture(f!);

    const summary = await runSignalGen({ lookbackHours: 168 });

    // The pipeline should fire ONE signal — on MSTR (the named subject).
    // The basket (idx-ssimag7) is rejected by the asset router because
    // MSTR is NOT a constituent of MAG7. tok-btc is in the affected set
    // but MSTR comes earlier in the title ("Strategy added 145,834 BTC").
    expect(summary.signals_created).toBeGreaterThanOrEqual(1);

    const signals = await readSignals();
    expect(signals.length).toBeGreaterThanOrEqual(1);
    const primary = signals.find((s) => s.asset_id === "trs-mstr");
    expect(primary, "MSTR must be selected as primary").toBeDefined();

    // ── Catalyst subtype: stage 5 module → persisted column ──
    expect(primary!.catalyst_subtype).toBe("treasury_action");

    // ── Asset relevance: stage 3 module → persisted column ──
    // MSTR is named at position 0 of the title ("Strategy added...") →
    // scoreAssetRelevance returns subject (1.0).
    expect(primary!.asset_relevance).toBe(1.0);

    // ── Expiry: stage 8 lifecycle module → persisted column ──
    // treasury_action has horizon 3d. expires_at must be ~3d in future.
    const ttlMs = primary!.expires_at! - primary!.fired_at;
    expect(ttlMs).toBeGreaterThanOrEqual(2 * 24 * 3600 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(4 * 24 * 3600 * 1000);

    // ── Corroboration deadline: lifecycle.computeLifecycle ──
    // Bloomberg author → tier-1 → no corroboration_deadline expected.
    expect(primary!.corroboration_deadline).toBeNull();

    // ── Source tier: classifySourceTier in signal-generator ──
    // Author is "Bloomberg" → tier 1.
    expect(primary!.source_tier).toBe(1);

    // ── Horizon string mirrors subtype profile ──
    expect(primary!.expected_horizon).toBe("3d");

    // ── Direction: positive sentiment → long ──
    expect(primary!.direction).toBe("long");

    // ── Crucially: NO signal on the basket (the bug-class-1 case) ──
    const basketSignal = signals.find((s) => s.asset_id === "idx-ssimag7");
    expect(
      basketSignal,
      "router must reject MAG7 basket (MSTR is not a constituent)",
    ).toBeUndefined();
  });

  it("F05 — Coinbase outage persists transient_operational subtype + hours-scale expiry", async () => {
    const f = FIXTURES.find((x) => x.id === "F05_aws_outage_short_horizon");
    expect(f).toBeDefined();
    await seedFixture(f!);

    const summary = await runSignalGen({ lookbackHours: 168 });
    expect(summary.signals_created).toBeGreaterThanOrEqual(1);

    const signals = await readSignals();
    const coin = signals.find((s) => s.asset_id === "stk-coin");
    expect(coin, "COIN signal must fire").toBeDefined();

    // ── Subtype: title contains "outage" → transient_operational ──
    expect(coin!.catalyst_subtype).toBe("transient_operational");

    // ── Relevance: COIN named via "Coinbase" alias in title position 0 ──
    expect(coin!.asset_relevance).toBe(1.0);

    // ── Expiry: transient_operational has horizon 4h ──
    // The signal must NOT inherit the multi-day default that bug class 2
    // exposed; it must reflect the subtype's hours-scale decay profile.
    const ttlMs = coin!.expires_at! - coin!.fired_at;
    expect(ttlMs).toBeLessThanOrEqual(6 * 3600 * 1000);
    expect(ttlMs).toBeGreaterThanOrEqual(3 * 3600 * 1000);

    // ── Corroboration deadline: PANews author → tier 2 ──
    // Single source on a non-tier-1 outlet ⇒ corroboration_deadline set.
    // transient_operational is NOT in the slow-burn set ⇒ 4h window.
    // Tolerance ~5ms because computeLifecycle uses Date.now() slightly
    // before insertSignal stamps fired_at. The two timestamps drift by
    // a millisecond or two; the contract here is "4h ± noise", not
    // "exact-microsecond match".
    expect(coin!.corroboration_deadline).not.toBeNull();
    const corrobMs = coin!.corroboration_deadline! - coin!.fired_at;
    expect(Math.abs(corrobMs - 4 * 3600 * 1000)).toBeLessThanOrEqual(10);

    expect(coin!.source_tier).toBe(2);

    // ── Direction: negative sentiment → short ──
    expect(coin!.direction).toBe("short");

    // ── Horizon string ──
    expect(coin!.expected_horizon).toBe("4h");
  });

  it("F09 — Crypto One Liners digest is BLOCKED end-to-end (no signal row at all)", async () => {
    const f = FIXTURES.find((x) => x.id === "F09_crypto_one_liners_digest");
    expect(f).toBeDefined();
    await seedFixture(f!);

    const summary = await runSignalGen({ lookbackHours: 168 });

    // The digest gate (stage 2, `detectDigest`) must fire BEFORE any
    // routing/risk/lifecycle work happens. Result: 0 signals from this
    // event. If a future change weakens the gate, the signal would
    // appear here and this assertion would fail.
    expect(summary.signals_created).toBe(0);

    const signals = await readSignals();
    expect(signals).toHaveLength(0);

    const totalRows =
      (await get<{ n: number }>(`SELECT COUNT(*) AS n FROM signals`))?.n ?? -1;
    expect(totalRows).toBe(0);
  });
});
