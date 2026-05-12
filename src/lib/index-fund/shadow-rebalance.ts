/**
 * Shadow rebalance — Part 2 of v2.1 attribution (I-37).
 *
 * On every live rebalance cycle, this also runs the OTHER framework
 * (the one not currently selected) against a virtual ledger so we
 * accumulate side-by-side data for comparison. Both frameworks see
 * the same news signals and the same kline data on the same cycle —
 * the only difference is the allocator that consumes them.
 *
 * Mechanics:
 *   1. Read shadow's previous NAV + last rebalance new_weights.
 *   2. Mark-to-market the previous weights against today's prices to
 *      compute the new shadow NAV.
 *   3. Compute fresh weights using the shadow framework's allocator.
 *   4. Persist the new shadow NAV + cash to `shadow_portfolio`.
 *   5. Write a `index_rebalances` row tagged with the shadow's
 *      framework_version so the calibration page can render its
 *      history alongside the live framework.
 *
 * This must NEVER throw into the live rebalance flow — it runs in a
 * try/catch in `rebalance.ts` and only logs failures.
 */

import { randomUUID } from "node:crypto";
import { Assets, IndexFund, Outcomes, ShadowPortfolio, db } from "@/lib/db";
import { Market } from "@/lib/sodex";
import { computeCandidatePortfolio } from "./weights";
import { computeCandidatePortfolioV2 } from "@/lib/alphaindex/v2/live-adapter";

/**
 * v2.1 / v1 framework-specific stop/target pairs used when materializing
 * shadow outcomes. v1 uses the original signal's suggested levels;
 * v2.1 widens the band to reflect its drawdown-controlled approach.
 * These are observability defaults — they do NOT change live trading.
 */
const SHADOW_TARGETS: Record<"v1" | "v2", { target_pct: number; stop_pct: number }> = {
  v1: { target_pct: 5, stop_pct: 3 },
  v2: { target_pct: 8, stop_pct: 5 },
};

export interface ShadowRebalanceResult {
  framework: "v1" | "v2";
  pre_nav: number;
  post_nav: number;
  weights: Record<string, number>;
  rebalance_id: string;
}

/**
 * Run the shadow framework's rebalance for the given shadow framework.
 * `liveFramework` is the framework currently selected; we always
 * shadow the OTHER one. Pure side-effect on `shadow_portfolio` and
 * `index_rebalances`.
 */
export async function runShadowRebalance(
  indexId: string,
  liveFramework: "v1" | "v2",
): Promise<ShadowRebalanceResult> {
  const shadowFw: "v1" | "v2" = liveFramework === "v1" ? "v2" : "v1";

  // ── 1. Read shadow's previous state
  ShadowPortfolio.ensureShadowsSeeded(10_000);
  const shadow = ShadowPortfolio.getShadow(shadowFw);
  if (!shadow) {
    throw new Error(`shadow ${shadowFw} row missing after seed`);
  }
  const prevNav = shadow.nav_usd;

  // ── 2. Mark-to-market against the previous rebalance's new_weights.
  // We pull the most recent rebalance for this index AND framework.
  const lastReb = db()
    .prepare<
      [string, string],
      { new_weights: string; rebalanced_at: number }
    >(
      `SELECT new_weights, rebalanced_at FROM index_rebalances
       WHERE index_id = ? AND framework_version = ?
       ORDER BY rebalanced_at DESC LIMIT 1`,
    )
    .get(indexId, shadowFw);

  let postPnLNav = prevNav;
  if (lastReb) {
    const oldWeights = safeJson<Record<string, number>>(lastReb.new_weights, {});
    // Mark-to-market: assume each weight bought at the previous
    // rebalance's price and held until now. Look up klines bracket.
    const tickers = await Market.getAllTickersBySymbol().catch(
      () => new Map(),
    );
    let nextNotional = 0;
    let oldNotional = 0;
    for (const [assetId, w] of Object.entries(oldWeights)) {
      const a = Assets.getAssetById(assetId);
      if (!a?.tradable) continue;
      const sodex = a.tradable.symbol;
      const livePx = livePrice(tickers, sodex);
      const klineRow = db()
        .prepare<
          [string, number],
          { close: number }
        >(
          `SELECT close FROM klines_daily
           WHERE asset_id = ?
             AND date <= date(?, 'unixepoch')
           ORDER BY date DESC LIMIT 1`,
        )
        .get(assetId, lastReb.rebalanced_at / 1000);
      if (livePx == null || !klineRow || klineRow.close <= 0) continue;
      const dollarsAtRebalance = prevNav * w;
      const qty = dollarsAtRebalance / klineRow.close;
      nextNotional += qty * livePx;
      oldNotional += dollarsAtRebalance;
    }
    if (oldNotional > 0) {
      // Apply position-level return to the notional, leave cash alone.
      const cashFraction =
        Math.max(0, 1 - Object.values(oldWeights).reduce((s, x) => s + x, 0));
      const cashDollars = prevNav * cashFraction;
      postPnLNav = nextNotional + cashDollars;
    }
  }

  // ── 3. Compute fresh shadow weights
  const candidate =
    shadowFw === "v2" ? computeCandidatePortfolioV2() : computeCandidatePortfolio();

  // ── 4. Persist the new shadow NAV
  const cashUsd = postPnLNav * candidate.cash_weight;
  ShadowPortfolio.updateShadow(
    shadowFw,
    postPnLNav,
    cashUsd,
    new Date().toISOString().replace("T", " ").slice(0, 19),
  );

  // ── 5. Write a rebalance row tagged shadowFw. We intentionally
  // record empty trades_made — shadow doesn't trade. The reasoning
  // string makes the shadow nature explicit so the rebalance history
  // panel can group / filter accordingly.
  const rebalanceId = randomUUID();
  IndexFund.insertRebalance({
    id: rebalanceId,
    index_id: indexId,
    triggered_by: "scheduled",
    pre_nav: prevNav,
    post_nav: postPnLNav,
    old_weights: lastReb
      ? safeJson<Record<string, number>>(lastReb.new_weights, {})
      : {},
    new_weights: candidate.weights,
    trades_made: [],
    reasoning: `[shadow ${shadowFw}] paper-traded in parallel with live ${liveFramework}; no trades executed.`,
    reviewer_model: null,
    framework_version: shadowFw,
  });

  // ── 6. Shadow signal outcomes (Part 2 / I-40).
  // For every recently-fired signal whose asset has a non-zero weight
  // in the shadow portfolio, emit a v2-tagged signal_outcomes row so
  // the calibration dashboard can render shadow hit rates / PnL.
  // Idempotent — `recordShadowOutcomeFromSignal` uses INSERT OR IGNORE.
  try {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const heldAssets = new Set(
      Object.entries(candidate.weights)
        .filter(([, w]) => w > 0)
        .map(([k]) => k),
    );
    interface SigPickRow {
      id: string;
      asset_id: string;
    }
    const sigs = db()
      .prepare<[number], SigPickRow>(
        `SELECT id, asset_id FROM signals
         WHERE fired_at >= ? AND status IN ('pending','executed')`,
      )
      .all(cutoff);
    const targets = SHADOW_TARGETS[shadowFw];
    for (const s of sigs) {
      if (!heldAssets.has(s.asset_id)) continue;
      const a = Assets.getAssetById(s.asset_id);
      const sodex = a?.tradable?.symbol;
      const px = sodex ? livePrice(await Market.getAllTickersBySymbol().catch(() => new Map()), sodex) : null;
      Outcomes.recordShadowOutcomeFromSignal({
        signal_id: s.id,
        framework_version: shadowFw,
        asset_class: classifyAssetClass(s.asset_id),
        price_at_generation: px,
        target_pct: targets.target_pct,
        stop_pct: targets.stop_pct,
      });
    }
  } catch (err) {
    // Non-fatal — shadow outcomes are observability.
    console.warn("[shadow-outcomes] skipped:", (err as Error).message);
  }

  return {
    framework: shadowFw,
    pre_nav: prevNav,
    post_nav: postPnLNav,
    weights: candidate.weights,
    rebalance_id: rebalanceId,
  };
}

/**
 * Approximate asset class from id prefix. The full classifier lives in
 * `pipeline/base-rates.ts` but pulling that in for the shadow path
 * would couple too many subsystems.
 */
function classifyAssetClass(asset_id: string): string {
  if (asset_id === "tok-btc" || asset_id === "tok-eth" || asset_id === "tok-sol")
    return "large_cap_crypto";
  if (asset_id.startsWith("rwa-")) return "rwa";
  if (asset_id.startsWith("stk-")) return "crypto_adjacent_equity";
  if (asset_id.startsWith("idx-")) return "crypto_index";
  if (asset_id.startsWith("tok-")) return "mid_cap_crypto";
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function livePrice(
  tickers: unknown,
  sym: string,
): number | null {
  if (!sym) return null;
  const m = tickers as Map<string, { lastPx: string }>;
  const t = m.get(sym);
  if (!t) return null;
  const n = Number(t.lastPx);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
