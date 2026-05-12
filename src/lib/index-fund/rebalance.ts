/**
 * Rebalance executor — turns target weights into actual paper trades.
 *
 * Flow:
 *   1. Load current positions for the index → mark-to-market via SoDEX prices
 *   2. Compute current NAV (positions + cash)
 *   3. Compare current weights to target weights
 *   4. For each delta above threshold: open a paper trade (buy or sell)
 *   5. Update positions table with new quantities + values
 *   6. Insert rebalance record + snapshot NAV
 *
 * Trades are simulated against current SoDEX last price (no slippage).
 * That's intentional for the build-a-thon — production would route to
 * the existing paper-executor with proper stop/target logic, but for an
 * index we just want immediate fills.
 */

import { randomUUID } from "node:crypto";
import {
  Assets,
  IndexFund,
  Settings,
  type IndexPositionRow,
} from "@/lib/db";
import { Market } from "@/lib/sodex";
import { computeCandidatePortfolio } from "./weights";
import { reviewCandidate } from "./ai-review";
import {
  recordAttributionAtRebalance,
  resolvePendingAttributions,
} from "@/lib/alphaindex/signal-attribution-job";
import { computeCandidatePortfolioV2 } from "@/lib/alphaindex/v2/live-adapter";
import { runShadowRebalance } from "./shadow-rebalance";

export interface RebalanceSummary {
  ok: boolean;
  index_id: string;
  rebalance_id: string;
  pre_nav: number;
  post_nav: number;
  trades: Array<{
    asset_id: string;
    side: "buy" | "sell";
    size_usd: number;
    fill_price: number;
  }>;
  reasoning: string;
  reviewer_model: string | null;
  weights: Record<string, number>;
  /** Why we skipped tiny deltas / no-changes etc. */
  skipped: number;
}

export interface RebalanceOptions {
  triggered_by?: "scheduled" | "manual" | "signal_cluster";
  /** When false, the rebalance computes weights and returns the plan
   *  without touching positions. Useful for previewing. */
  execute?: boolean;
}

export async function rebalanceIndex(
  indexId = "alphacore",
  opts: RebalanceOptions = {},
): Promise<RebalanceSummary> {
  const idx = IndexFund.getIndex(indexId);
  if (!idx) throw new Error(`index '${indexId}' not found`);

  const settings = Settings.getSettings();
  const triggered_by = opts.triggered_by ?? "scheduled";
  const execute = opts.execute ?? true;
  const framework = settings.index_framework_version ?? "v1";

  // ── 1. Compute target weights (rules → Claude review) ─────────
  // Framework dispatch: v1 = legacy weights engine; v2 = graduated
  // drawdown-controlled allocator (FRAMEWORK_NOTES.md). Live default
  // is v1 unless the user has opted into v2 via the framework selector
  // with explicit confirmation (I-36).
  const candidate =
    framework === "v2" ? computeCandidatePortfolioV2() : computeCandidatePortfolio();
  const review = await reviewCandidate(candidate);

  // Build per-asset rationale from the rules engine's drivers. The driver
  // strings already explain anchor base / momentum / signal contribution
  // in the same vocabulary the user sees in the dashboard, so we just
  // join them with " · " for display.
  const rationaleByAsset = new Map<string, string>();
  for (const s of candidate.scores) {
    if (s.drivers.length > 0) {
      rationaleByAsset.set(s.asset.id, s.drivers.join(" · "));
    }
  }

  // ── 2. Mark current positions to market ───────────────────────
  const tickers = await Market.getAllTickersBySymbol().catch(
    () => new Map<string, never>(),
  );
  const livePrice = (sodexSymbol: string): number | null => {
    const t = (tickers as unknown as Map<string, { lastPx: string }>).get(
      sodexSymbol,
    );
    if (!t) return null;
    const n = Number(t.lastPx);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const currentPositions = IndexFund.listPositions(indexId);
  const positionMap = new Map<string, IndexPositionRow>();
  let portfolioMtm = 0;

  for (const p of currentPositions) {
    const asset = Assets.getAssetById(p.asset_id);
    if (!asset?.tradable) {
      positionMap.set(p.asset_id, p);
      portfolioMtm += p.current_value_usd;
      continue;
    }
    const px = livePrice(asset.tradable.symbol);
    const value = px != null ? p.quantity * px : p.current_value_usd;
    positionMap.set(p.asset_id, { ...p, current_value_usd: value });
    portfolioMtm += value;
  }

  // Cash = starting NAV + realised P&L from previous trades, less invested.
  // Simplified for v1: cash = starting_nav - sum(invested capital so far).
  // We track a running cash by computing on-the-fly each rebalance: cash =
  // last NAV - portfolioMtm at the end. For first rebalance, cash =
  // starting_nav.
  const lastNavRow = IndexFund.listNavHistory(indexId, 1)[0];
  const lastNav = lastNavRow?.nav_usd ?? idx.starting_nav;
  const cash = Math.max(0, lastNav - portfolioMtm);
  const preNav = portfolioMtm + cash;

  // ── 3. Compute target dollar values ───────────────────────────
  const targetUsd: Record<string, number> = {};
  for (const [assetId, w] of Object.entries(review.weights)) {
    targetUsd[assetId] = preNav * w;
  }
  const targetCashUsd = preNav * review.cash_weight;

  // ── 4. Compute deltas + plan trades ───────────────────────────
  const allInvolvedAssetIds = new Set<string>([
    ...Object.keys(targetUsd),
    ...positionMap.keys(),
  ]);

  const thresholdUsd = (settings.index_rebalance_threshold_pct / 100) * preNav;

  const trades: RebalanceSummary["trades"] = [];
  const updatedPositions: Map<string, { quantity: number; valueUsd: number; lastPrice: number | null }> = new Map();
  let skipped = 0;

  for (const assetId of allInvolvedAssetIds) {
    const asset = Assets.getAssetById(assetId);
    if (!asset?.tradable) {
      skipped++;
      continue;
    }
    const symbol = asset.tradable.symbol;
    const px = livePrice(symbol);
    if (px == null) {
      // No price → leave position untouched.
      const existing = positionMap.get(assetId);
      if (existing) {
        updatedPositions.set(assetId, {
          quantity: existing.quantity,
          valueUsd: existing.current_value_usd,
          lastPrice: existing.avg_entry_price,
        });
      }
      skipped++;
      continue;
    }

    const currentValue = positionMap.get(assetId)?.current_value_usd ?? 0;
    const targetValue = targetUsd[assetId] ?? 0;
    const deltaUsd = targetValue - currentValue;

    if (Math.abs(deltaUsd) < thresholdUsd) {
      // Below threshold — keep as-is.
      const existing = positionMap.get(assetId);
      const qty = existing?.quantity ?? 0;
      updatedPositions.set(assetId, {
        quantity: qty,
        valueUsd: currentValue,
        lastPrice: existing?.avg_entry_price ?? px,
      });
      continue;
    }

    if (deltaUsd > 0) {
      // BUY
      const buyQty = deltaUsd / px;
      const existing = positionMap.get(assetId);
      const newQty = (existing?.quantity ?? 0) + buyQty;
      const newAvg = existing
        ? ((existing.avg_entry_price ?? px) * existing.quantity + px * buyQty) /
          newQty
        : px;
      updatedPositions.set(assetId, {
        quantity: newQty,
        valueUsd: targetValue,
        lastPrice: newAvg,
      });
      trades.push({
        asset_id: assetId,
        side: "buy",
        size_usd: deltaUsd,
        fill_price: px,
      });
    } else {
      // SELL
      const sellQty = -deltaUsd / px;
      const existing = positionMap.get(assetId)!;
      const newQty = Math.max(0, existing.quantity - sellQty);
      updatedPositions.set(assetId, {
        quantity: newQty,
        valueUsd: targetValue,
        lastPrice: existing.avg_entry_price,
      });
      trades.push({
        asset_id: assetId,
        side: "sell",
        size_usd: -deltaUsd,
        fill_price: px,
      });
    }
  }

  // ── 5. Persist ─────────────────────────────────────────────────
  const oldWeights: Record<string, number> = {};
  for (const p of currentPositions) {
    oldWeights[p.asset_id] = preNav > 0 ? p.current_value_usd / preNav : 0;
  }

  if (execute) {
    // Wipe positions that fell out of the target.
    for (const old of currentPositions) {
      if (!updatedPositions.has(old.asset_id)) {
        // Position dropped — sell entirely.
        if (old.quantity > 0) {
          const asset = Assets.getAssetById(old.asset_id);
          const px =
            asset?.tradable ? livePrice(asset.tradable.symbol) : null;
          if (px != null) {
            trades.push({
              asset_id: old.asset_id,
              side: "sell",
              size_usd: old.quantity * px,
              fill_price: px,
            });
          }
          IndexFund.upsertPosition({
            index_id: indexId,
            asset_id: old.asset_id,
            target_weight: 0,
            current_value_usd: 0,
            quantity: 0,
            avg_entry_price: null,
            rationale: null, // dropped from portfolio — clear stale reasoning
          });
        }
      }
    }

    // Upsert each updated/new position.
    for (const [assetId, u] of updatedPositions) {
      const tw = (review.weights[assetId] ?? 0);
      // Pass rationale only when we have a fresh one from this rebalance's
      // scoring pass; otherwise leave the existing rationale untouched
      // (undefined preserves it). This avoids wiping reasoning for an
      // asset that was kept under threshold and not re-scored.
      const rationale = rationaleByAsset.has(assetId)
        ? rationaleByAsset.get(assetId)!
        : undefined;
      IndexFund.upsertPosition({
        index_id: indexId,
        asset_id: assetId,
        target_weight: tw,
        current_value_usd: u.valueUsd,
        quantity: u.quantity,
        avg_entry_price: u.lastPrice,
        rationale,
      });
    }

    // Drop zero positions out of the table.
    IndexFund.clearZeroPositions(indexId);
  }

  // ── 6. Compute post-NAV (positions + cash) ─────────────────────
  let postPortfolio = 0;
  for (const u of updatedPositions.values()) postPortfolio += u.valueUsd;
  const postNav = postPortfolio + targetCashUsd;

  // ── 7. Insert rebalance row + snapshot NAV ────────────────────
  const rebalanceId = randomUUID();
  if (execute) {
    IndexFund.insertRebalance({
      id: rebalanceId,
      index_id: indexId,
      triggered_by,
      pre_nav: preNav,
      post_nav: postNav,
      old_weights: oldWeights,
      new_weights: review.weights,
      trades_made: trades,
      reasoning: review.reasoning,
      reviewer_model: review.reviewer_model,
      framework_version: framework as "v1" | "v2",
    });

    const today = new Date().toISOString().slice(0, 10);
    const pnl_usd = postNav - idx.starting_nav;
    const pnl_pct = idx.starting_nav > 0 ? (pnl_usd / idx.starting_nav) * 100 : 0;
    IndexFund.snapshotNav({
      index_id: indexId,
      date: today,
      nav_usd: postNav,
      pnl_usd,
      pnl_pct,
      btc_price: livePrice("vBTC_vUSDC") ?? null,
      ssimag7_price: livePrice("vMAG7ssi_vUSDC") ?? null,
    });

    // ── Part 3: signal P&L attribution ───────────────────────────
    // Best-effort. A failure here must NEVER abort a rebalance —
    // attribution is observability, not a load-bearing path. We log
    // and move on so the live portfolio is unaffected.
    try {
      // Resolve last rebalance's pending attribution against today's prices.
      resolvePendingAttributions(indexId);
      // Then record this rebalance's tilt vs. the momentum-only counterfactual.
      recordAttributionAtRebalance({
        index_id: indexId,
        rebalance_id: rebalanceId,
        actual_weights: review.weights,
        pre_nav_usd: preNav,
      });
    } catch (err) {
      // Avoid crashing the rebalance — log and continue.
      console.warn("[signal-attribution] skipped:", (err as Error).message);
    }

    // ── Shadow framework rebalance (Part 2 of v2.1 attribution / I-37).
    // Runs the OTHER framework against the shadow_portfolio ledger so
    // both frameworks accumulate side-by-side data. Identical signal
    // and kline inputs to the live framework on this cycle. Best-effort:
    // never aborts the live path.
    try {
      await runShadowRebalance(indexId, framework as "v1" | "v2");
    } catch (err) {
      console.warn("[shadow-rebalance] skipped:", (err as Error).message);
    }
  }

  return {
    ok: true,
    index_id: indexId,
    rebalance_id: rebalanceId,
    pre_nav: preNav,
    post_nav: postNav,
    trades,
    reasoning: review.reasoning,
    reviewer_model: review.reviewer_model,
    weights: review.weights,
    skipped,
  };
}
