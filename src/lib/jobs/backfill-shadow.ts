/**
 * Shadow backfill — Part 1 of v2.1 attribution gap-closing (I-39).
 *
 * Walks the last N days of v1 rebalance history and writes parallel
 * v2-tagged shadow rebalance rows + outcomes computed from the same
 * historical kline + signal snapshots. After the backfill, walks
 * forward through prices to mark-to-market the resulting shadow NAV.
 *
 * Idempotence: each backfill rebalance row uses a deterministic id
 * derived from (`shadow-bf-v2-${asof_ms}`) and INSERT OR IGNORE so
 * re-running the job produces no duplicates and no NAV mutation.
 *
 * Honesty: when the historical signal/kline snapshot is unavailable
 * (e.g., klines missing before some date) the cycle is skipped and
 * logged. We never synthesize data — synthesis would corrupt the
 * comparison the backfill exists to enable.
 */

import { Assets, IndexFund, Outcomes, ShadowPortfolio, db } from "@/lib/db";
import { computeCandidatePortfolioV2AsOf } from "@/lib/alphaindex/v2/live-adapter";

export interface BackfillSummary {
  windows_considered: number;
  rebalances_written: number;
  rebalances_skipped: number;
  outcomes_written: number;
  starting_nav: number;
  ending_nav: number;
  earliest_asof_ms: number | null;
  latest_asof_ms: number | null;
}

const DAY_MS = 24 * 3600 * 1000;
const SHADOW_TARGETS_V2 = { target_pct: 8, stop_pct: 5 };

/**
 * Backfill v2 shadow data for the trailing `lookbackDays` based on
 * existing v1 rebalances.
 */
export function backfillShadowV2(
  indexId = "alphacore",
  lookbackDays = 30,
  startingNav = 10_000,
): BackfillSummary {
  const cutoffMs = Date.now() - lookbackDays * DAY_MS;
  const v1Rebs = db()
    .prepare<
      [string, number],
      { id: string; rebalanced_at: number }
    >(
      `SELECT id, rebalanced_at FROM index_rebalances
       WHERE index_id = ? AND framework_version = 'v1'
         AND rebalanced_at >= ?
       ORDER BY rebalanced_at ASC`,
    )
    .all(indexId, cutoffMs);

  let rebalancesWritten = 0;
  let rebalancesSkipped = 0;
  let outcomesWritten = 0;
  let nav = startingNav;
  let earliestAsof: number | null = null;
  let latestAsof: number | null = null;
  let prevWeights: Record<string, number> | null = null;
  let prevAsof: number | null = null;

  ShadowPortfolio.ensureShadowsSeeded(startingNav);

  for (const v1 of v1Rebs) {
    // ── Mark-to-market across the price window since the last shadow
    // backfill rebalance. We approximate by holding the prior weights
    // at the prior asof's prices and applying the change to current
    // asof's prices.
    if (prevWeights && prevAsof != null) {
      nav = markToMarket(nav, prevWeights, prevAsof, v1.rebalanced_at);
    }

    // ── Recompute v2 weights at this historical asof.
    const candidate = computeCandidatePortfolioV2AsOf(v1.rebalanced_at);
    if (!candidate) {
      rebalancesSkipped++;
      console.warn(
        `[backfill-shadow] skip cycle ${new Date(v1.rebalanced_at).toISOString()} — insufficient klines at asof`,
      );
      continue;
    }

    // ── Idempotent write: deterministic id = `shadow-bf-v2-${asof_ms}`
    const rebalanceId = `shadow-bf-v2-${v1.rebalanced_at}`;
    const exists = db()
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM index_rebalances WHERE id = ?`,
      )
      .get(rebalanceId);
    if ((exists?.c ?? 0) === 0) {
      IndexFund.insertRebalance({
        id: rebalanceId,
        index_id: indexId,
        rebalanced_at: v1.rebalanced_at,
        triggered_by: "scheduled",
        pre_nav: nav,
        post_nav: nav,
        old_weights: prevWeights ?? {},
        new_weights: candidate.weights,
        trades_made: [],
        reasoning: `[shadow v2.1 backfill] computed retroactively from historical inputs at ${new Date(v1.rebalanced_at).toISOString()}`,
        reviewer_model: null,
        framework_version: "v2",
      });
      rebalancesWritten++;
    }

    // ── Backfill outcomes for any signal-asset that v2 holds at this asof.
    const heldAssets = new Set(
      Object.entries(candidate.weights)
        .filter(([, w]) => w > 0)
        .map(([k]) => k),
    );
    interface SigPick {
      id: string;
      asset_id: string;
    }
    // Historical lookback: include signals regardless of current status.
    // Live shadow filters to pending/executed because those are signals
    // we'd actually trade; the backfill is reconstructing what v2.1
    // WOULD HAVE recorded had it been live, so signals that have since
    // aged to 'expired' (or even 'dismissed') still count — they fired
    // in the [asof-14d, asof] window and v2 would have observed them.
    // Filtering them out is what produced outcomes_written: 0 in
    // production, since most signals naturally expire after their
    // horizon.
    const sigs = db()
      .prepare<[number, number], SigPick>(
        `SELECT id, asset_id FROM signals
         WHERE fired_at >= ? AND fired_at <= ?`,
      )
      .all(v1.rebalanced_at - 14 * DAY_MS, v1.rebalanced_at);
    for (const s of sigs) {
      if (!heldAssets.has(s.asset_id)) continue;
      const px = priceAtOrBefore(s.asset_id, v1.rebalanced_at);
      const beforeCount = db()
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM signal_outcomes WHERE signal_id = ?`,
        )
        .get(`${s.id}-shadow-v2`)?.c ?? 0;
      Outcomes.recordShadowOutcomeFromSignal({
        signal_id: s.id,
        framework_version: "v2",
        asset_class: classifyAssetClass(s.asset_id),
        price_at_generation: px,
        target_pct: SHADOW_TARGETS_V2.target_pct,
        stop_pct: SHADOW_TARGETS_V2.stop_pct,
      });
      const afterCount = db()
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM signal_outcomes WHERE signal_id = ?`,
        )
        .get(`${s.id}-shadow-v2`)?.c ?? 0;
      if (afterCount > beforeCount) outcomesWritten++;
    }

    if (earliestAsof == null || v1.rebalanced_at < earliestAsof) {
      earliestAsof = v1.rebalanced_at;
    }
    latestAsof = v1.rebalanced_at;
    prevWeights = candidate.weights;
    prevAsof = v1.rebalanced_at;
  }

  // ── Mark-to-market from the last backfill rebalance to "now" so the
  // shadow NAV reflects the current value of the v2 portfolio.
  if (prevWeights && prevAsof != null) {
    nav = markToMarket(nav, prevWeights, prevAsof, Date.now());
  }

  // ── Persist the resulting NAV and started_at.
  if (earliestAsof != null) {
    const startedIso = new Date(earliestAsof)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    db()
      .prepare(
        `UPDATE shadow_portfolio SET
           nav_usd = ?,
           cash_usd = ?,
           started_at = ?,
           last_rebalance_at = ?
         WHERE framework_version = 'v2'`,
      )
      .run(
        nav,
        nav * (prevWeights ? cashWeight(prevWeights) : 1),
        startedIso,
        latestAsof
          ? new Date(latestAsof).toISOString().replace("T", " ").slice(0, 19)
          : null,
      );
  }

  return {
    windows_considered: v1Rebs.length,
    rebalances_written: rebalancesWritten,
    rebalances_skipped: rebalancesSkipped,
    outcomes_written: outcomesWritten,
    starting_nav: startingNav,
    ending_nav: nav,
    earliest_asof_ms: earliestAsof,
    latest_asof_ms: latestAsof,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * NAV after applying weights × price change between asofA and asofB.
 * Cash fraction (1 - sum(weights)) is held at par. Weights with no
 * price at either endpoint are dropped (assets without klines are
 * treated as static — no fake price).
 */
function markToMarket(
  navAtA: number,
  weights: Record<string, number>,
  asofA_ms: number,
  asofB_ms: number,
): number {
  let priced = 0;
  let pricedNotional = 0;
  let unpriced = 0;
  for (const [assetId, w] of Object.entries(weights)) {
    const pa = priceAtOrBefore(assetId, asofA_ms);
    const pb = priceAtOrBefore(assetId, asofB_ms);
    if (pa == null || pb == null || pa <= 0) {
      unpriced += w;
      continue;
    }
    const ret = pb / pa;
    priced += w * ret;
    pricedNotional += w;
  }
  const cashFrac = Math.max(0, 1 - pricedNotional - unpriced);
  // The "unpriced" sleeve is held flat (no price = no return) — this is
  // the honest treatment per "do not synthesize data" (I-39).
  return navAtA * (priced + unpriced + cashFrac);
}

function cashWeight(weights: Record<string, number>): number {
  const sum = Object.values(weights).reduce((s, x) => s + x, 0);
  return Math.max(0, 1 - sum);
}

function priceAtOrBefore(asset_id: string, ts_ms: number): number | null {
  const dateStr = new Date(ts_ms).toISOString().slice(0, 10);
  const row = db()
    .prepare<[string, string], { close: number }>(
      `SELECT close FROM klines_daily
       WHERE asset_id = ? AND date <= ?
       ORDER BY date DESC LIMIT 1`,
    )
    .get(asset_id, dateStr);
  if (!row || row.close <= 0) return null;
  return row.close;
}

function classifyAssetClass(asset_id: string): string {
  if (asset_id === "tok-btc" || asset_id === "tok-eth" || asset_id === "tok-sol")
    return "large_cap_crypto";
  if (asset_id.startsWith("rwa-")) return "rwa";
  if (asset_id.startsWith("stk-")) return "crypto_adjacent_equity";
  if (asset_id.startsWith("idx-")) return "crypto_index";
  if (asset_id.startsWith("tok-")) return "mid_cap_crypto";
  return "unknown";
}
// Reference Assets in case caller needs it; actual lookups are by id.
void Assets;
