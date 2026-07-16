/**
 * v2.1 → live-rebalance adapter.
 *
 * The existing `rebalance.ts` flow consumes a `CandidatePortfolio`
 * shape (weights + cash + per-asset scores). This adapter runs the
 * v2.1 engine over current klines + signals and packages the output
 * into that shape so v2 can drive live rebalances when the user has
 * graduated v2.1 via the framework selector.
 *
 * Notes:
 *  - Signals are aggregated from the last 14 days, same window as v1.
 *  - Engine state (regime, breaker, peak NAV) is reconstructed each
 *    call from recent NAV history. v2's stateful behavior is meant to
 *    be sticky across rebalances; we approximate by walking the last
 *    30 days of NAV through the smoothed regime classifier.
 */

import { Assets, all } from "@/lib/db";
import type { CandidatePortfolio } from "@/lib/index-fund/types";
import type { Asset } from "@/lib/universe";
import {
  newEngineState,
  runV2Engine,
  type V2EngineState,
} from "./engine";
import {
  applyRegimeSmoothing,
  classifyRawRegime,
} from "./regime";
import type { DailyBar } from "../backtest";
import type { SignalEntry } from "./signal-integration";

const BTC_ID = "tok-btc";

/**
 * Historical-asof variant — runs v2 against the snapshot of klines +
 * signals available at `asofMs`, used by the shadow backfill job
 * (Part 1 / I-39). Klines after asof are truncated; signals are
 * aggregated within the 14d window ending at asof.
 *
 * Returns null when BTC has no klines at or before asof — the caller
 * skips that cycle rather than synthesizing data.
 */
export async function computeCandidatePortfolioV2AsOf(
  asofMs: number,
): Promise<CandidatePortfolio | null> {
  const fullSeries = await loadAllSeries();
  const series = new Map<string, DailyBar[]>();
  for (const [k, bars] of fullSeries.entries()) {
    const filtered = bars.filter((b) => b.ts_ms <= asofMs);
    if (filtered.length > 0) series.set(k, filtered);
  }
  const btcBars = series.get(BTC_ID);
  if (!btcBars || btcBars.length < 30) return null;

  // Reconstruct regime state from BTC's last 60 bars before asof.
  let state: V2EngineState = newEngineState();
  const lookback = btcBars.slice(-60);
  for (let i = 0; i < lookback.length; i++) {
    const window = btcBars
      .slice(
        Math.max(0, btcBars.length - 60 + i - 30),
        btcBars.length - 60 + i + 1,
      )
      .map((b) => b.close);
    const raw = classifyRawRegime(window);
    state.regime = applyRegimeSmoothing(state.regime, raw);
  }

  const signals = await loadAggregatedSignalsAsOf(asofMs);
  const result = runV2Engine({
    asof_ms: asofMs,
    series,
    current_nav: 1,
    signals,
    state,
  });
  return {
    weights: result.weights,
    cash_weight: result.cash_weight,
    scores: await buildScores(result.weights, result.meta.regime),
    meta: {
      candidates_considered: series.size,
      above_min_threshold: Object.keys(result.weights).length,
      capped_at_max: 0,
    },
  };
}

/**
 * Compute target weights using v2.1. Throws if klines are missing
 * for BTC — v2 is undefined without an anchor price series.
 */
export async function computeCandidatePortfolioV2(
  navOverride?: { currentNav: number; peakNav: number },
): Promise<CandidatePortfolio> {
  const series = await loadAllSeries();
  if (!series.has(BTC_ID)) {
    throw new Error(
      "computeCandidatePortfolioV2: tok-btc kline data missing — cannot run v2 anchor",
    );
  }

  // Reconstruct sticky regime state from last 30 BTC days. We don't
  // persist V2EngineState across rebalances yet (v3 work) — for now
  // the regime classifier walks recent history and converges quickly
  // because the smoothing is bounded at 3 days.
  const btcBars = series.get(BTC_ID)!;
  const today = btcBars[btcBars.length - 1].ts_ms;
  const state: V2EngineState = newEngineState();
  const lookback = btcBars.slice(-60); // 60 bars of warm-up
  for (let i = 0; i < lookback.length; i++) {
    // 30d trailing window for the regime classifier
    const window = btcBars
      .slice(Math.max(0, btcBars.length - 60 + i - 30), btcBars.length - 60 + i + 1)
      .map((b) => b.close);
    const raw = classifyRawRegime(window);
    state.regime = applyRegimeSmoothing(state.regime, raw);
  }

  // Load aggregated 14d signals.
  const signals = await loadAggregatedSignals();

  // Real NAV context so the drawdown circuit breaker actually works. The
  // old path hardcoded current_nav:1 with peak_nav:0, so drawdown was
  // ALWAYS 0 and the -8% / -12% breaker could never fire in the live
  // path — the exact safety rail the UI promises. Seed the engine with
  // the index NAV ledger (current = latest snapshot, peak = all-time
  // high); a live caller may override with the intraday mark-to-market.
  const nav = navOverride ?? (await loadIndexNavContext("alphacore"));
  state.peak_nav = nav.peakNav;

  const result = runV2Engine({
    asof_ms: today,
    series,
    current_nav: nav.currentNav,
    signals,
    state,
  });

  // Package into the v1-shaped CandidatePortfolio.
  const scores = await buildScores(result.weights, result.meta.regime);
  return {
    weights: result.weights,
    cash_weight: result.cash_weight,
    scores,
    meta: {
      candidates_considered: series.size,
      above_min_threshold: Object.keys(result.weights).length,
      capped_at_max: 0,
    },
  };
}

/**
 * The index's live NAV context for the circuit breaker: current NAV (latest
 * snapshot in the ledger) and its all-time peak. Falls back to a nominal 1.0
 * before any history exists (first rebalance — no drawdown possible yet).
 */
async function loadIndexNavContext(
  indexId: string,
): Promise<{ currentNav: number; peakNav: number }> {
  const rows = await all<{ nav_usd: number }>(
    `SELECT nav_usd FROM index_nav_history WHERE index_id = ? ORDER BY date ASC`,
    [indexId],
  );
  if (rows.length === 0) return { currentNav: 1, peakNav: 1 };
  const currentNav = rows[rows.length - 1].nav_usd;
  let peakNav = currentNav;
  for (const r of rows) if (r.nav_usd > peakNav) peakNav = r.nav_usd;
  return { currentNav, peakNav };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

async function loadAllSeries(): Promise<Map<string, DailyBar[]>> {
  const rows = await all<{
    asset_id: string;
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
  }>(
    `SELECT asset_id, date, open, high, low, close FROM klines_daily
     ORDER BY asset_id, date ASC`,
  );
  const series = new Map<string, DailyBar[]>();
  for (const r of rows) {
    const ts = Date.parse(r.date + "T00:00:00Z");
    if (!Number.isFinite(ts)) continue;
    let bars = series.get(r.asset_id);
    if (!bars) {
      bars = [];
      series.set(r.asset_id, bars);
    }
    bars.push({ ...r, ts_ms: ts });
  }
  return series;
}

async function loadAggregatedSignalsAsOf(
  asofMs: number,
): Promise<SignalEntry[]> {
  const windowMs = 14 * 24 * 60 * 60 * 1000;
  const cutoff = asofMs - windowMs;
  interface Row {
    asset_id: string;
    direction: string;
    confidence: number;
    fired_at: number;
  }
  const rows = await all<Row>(
    `SELECT asset_id, direction, confidence, fired_at FROM signals
     WHERE fired_at >= ? AND fired_at <= ?
       AND status IN ('pending','executed')`,
    [cutoff, asofMs],
  );
  const agg = new Map<string, number>();
  for (const r of rows) {
    const ageMs = asofMs - r.fired_at;
    const decay = Math.max(0, 1 - ageMs / windowMs);
    const signed = (r.direction === "long" ? 1 : -1) * r.confidence * decay;
    agg.set(r.asset_id, (agg.get(r.asset_id) ?? 0) + signed);
  }
  return [...agg.entries()].map(([asset_id, signed_score]) => ({
    asset_id,
    signed_score,
  }));
}

async function loadAggregatedSignals(): Promise<SignalEntry[]> {
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  interface Row {
    asset_id: string;
    direction: string;
    confidence: number;
    fired_at: number;
  }
  const rows = await all<Row>(
    `SELECT asset_id, direction, confidence, fired_at FROM signals
     WHERE fired_at >= ? AND status IN ('pending','executed')`,
    [cutoff],
  );
  const agg = new Map<string, number>();
  const now = Date.now();
  for (const r of rows) {
    const ageMs = now - r.fired_at;
    const decay = Math.max(0, 1 - ageMs / (14 * 24 * 60 * 60 * 1000));
    const signed = (r.direction === "long" ? 1 : -1) * r.confidence * decay;
    agg.set(r.asset_id, (agg.get(r.asset_id) ?? 0) + signed);
  }
  return [...agg.entries()].map(([asset_id, signed_score]) => ({
    asset_id,
    signed_score,
  }));
}

async function buildScores(
  weights: Record<string, number>,
  regime: string,
): Promise<import("@/lib/index-fund/types").CandidateScore[]> {
  const out: import("@/lib/index-fund/types").CandidateScore[] = [];
  for (const [assetId, w] of Object.entries(weights)) {
    const a = await Assets.getAssetById(assetId);
    if (!a) continue;
    out.push({
      asset: a as Asset,
      signal_score: 0,
      sector_score: 0,
      flow_score: 0,
      composite_score: w,
      drivers: [
        `v2.1 / regime ${regime}`,
        `target weight ${(w * 100).toFixed(1)}%`,
      ],
    });
  }
  return out.sort((a, b) => b.composite_score - a.composite_score);
}
