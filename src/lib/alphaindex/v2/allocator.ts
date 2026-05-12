/**
 * v2 — main allocator (Fix 1 + Fix 4 + regime composition).
 *
 * Pure function: takes a regime and a list of satellite candidates,
 * returns weights + cash. The engine is responsible for layering
 * vol-targeting (Fix 2), the circuit breaker (Fix 5), and bounded
 * signal boosts (Fix 6) on top of this output.
 *
 * Architecture:
 *   1. Regime fixes the BTC / satellites / cash split (Fix 3 params).
 *   2. Within satellites, candidates are ranked by 30d momentum,
 *      capped per-asset (8%) and per-cluster (15%).
 *   3. Tail pruning: positions <3% are removed; satellite count ≤ 10.
 *   4. BTC anchor enforced inside [40%, 70%] band (Fix 1).
 *   5. In DRAWDOWN, only `is_defensive` satellites are eligible — bear
 *      market is no time to chase momentum picks (Fix 6 prerequisite).
 *
 * The relative-weight ranking inside the satellite sleeve is purely
 * momentum-driven here. News-signal influence is added by the
 * signal-integration layer; it is bounded so this allocator's output
 * is always recognizable in the final book.
 *
 * Companion tests: tests/alphaindex-v2/allocator.test.ts.
 */

import type { Regime } from "./regime";

// ─────────────────────────────────────────────────────────────────────────
// Constants exposed for tests + invariants
// ─────────────────────────────────────────────────────────────────────────

/** Per-satellite hard cap (Fix 4) — default for CHOP/DRAWDOWN. */
export const MAX_SINGLE_SATELLITE = 0.08;
/** Per-thematic-cluster hard cap (Fix 4) — default for CHOP/DRAWDOWN. */
export const MAX_CLUSTER = 0.15;
/** v2.1: relaxed caps in TREND regime so winners can size up further. */
export const MAX_SINGLE_SATELLITE_TREND = 0.10;
export const MAX_CLUSTER_TREND = 0.18;
/** Tail-pruning minimum (Fix 4). Anything below is dropped. */
export const MIN_POSITION = 0.03;
/** Maximum count of distinct satellite positions (Fix 4). */
export const MAX_SATELLITES = 10;
/** BTC anchor band (Fix 1 + I-33). */
export const BTC_MIN = 0.40;
export const BTC_MAX = 0.70;

interface RegimeParams {
  btc: number;
  satellites: number;
  cash: number;
}

const REGIME_PARAMS: Record<Regime, RegimeParams> = {
  TREND: { btc: 0.50, satellites: 0.45, cash: 0.05 },
  CHOP: { btc: 0.60, satellites: 0.30, cash: 0.10 },
  DRAWDOWN: { btc: 0.40, satellites: 0.15, cash: 0.45 },
};

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

export interface SatelliteCandidate {
  asset_id: string;
  /** 30d return as a fraction (0.10 = +10%). */
  ret30d: number;
  /** Thematic cluster key — used for the per-cluster cap. */
  cluster: string;
  /** When true, asset survives DRAWDOWN regime; otherwise dropped. */
  is_defensive?: boolean;
}

export interface AllocatorInputs {
  regime: Regime;
  satellites: SatelliteCandidate[];
  btc_anchor_id: string;
}

export interface AllocatorResult {
  weights: Record<string, number>;
  cash_weight: number;
  /** Diagnostic: which assets were pruned by which rule. */
  meta: {
    regime: Regime;
    btc_target: number;
    satellite_target: number;
    pruned_below_min: number;
    pruned_cluster_cap: number;
    pruned_max_count: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Allocation
// ─────────────────────────────────────────────────────────────────────────

export function allocateV2(input: AllocatorInputs): AllocatorResult {
  const params = REGIME_PARAMS[input.regime];
  // v2.1: relax caps in TREND, keep CHOP/DRAWDOWN at the original v2 levels.
  const maxSingle =
    input.regime === "TREND" ? MAX_SINGLE_SATELLITE_TREND : MAX_SINGLE_SATELLITE;
  const maxCluster =
    input.regime === "TREND" ? MAX_CLUSTER_TREND : MAX_CLUSTER;

  // ── 1. Filter satellites by regime
  // In DRAWDOWN, only defensive sleeves (gold, USDC-equivalents) survive.
  let pool = input.satellites.filter((s) => {
    if (input.regime === "DRAWDOWN") return s.is_defensive === true;
    return s.ret30d > -0.10; // basic sanity: avoid free-fall picks
  });

  // ── 2. Rank by 30d momentum (descending)
  pool = pool.slice().sort((a, b) => b.ret30d - a.ret30d);

  // ── 3. Score → desired weight (relative)
  // Use rank-decayed weighting so lead candidates get more, tail less,
  // but capped per-asset by MAX_SINGLE_SATELLITE.
  const rankWeights = pool.map((_, i) => Math.pow(0.85, i));
  const rankSum = rankWeights.reduce((s, x) => s + x, 0) || 1;

  const desired = pool.map((s, i) => ({
    cand: s,
    desired: (rankWeights[i] / rankSum) * params.satellites,
  }));

  // ── 4. Per-asset cap (regime-aware; v2.1 relaxes in TREND)
  for (const d of desired) {
    if (d.desired > maxSingle) d.desired = maxSingle;
  }

  // ── 5. Per-cluster cap (regime-aware; v2.1 relaxes in TREND)
  const clusterTotals = new Map<string, number>();
  for (const d of desired) {
    clusterTotals.set(
      d.cand.cluster,
      (clusterTotals.get(d.cand.cluster) ?? 0) + d.desired,
    );
  }
  let prunedCluster = 0;
  for (const [cluster, total] of clusterTotals) {
    if (total > maxCluster) {
      const scale = maxCluster / total;
      for (const d of desired) {
        if (d.cand.cluster === cluster) {
          const before = d.desired;
          d.desired *= scale;
          prunedCluster += before - d.desired;
        }
      }
    }
  }

  // ── 6. Tail prune — drop anything below MIN_POSITION
  let prunedBelow = 0;
  for (const d of desired) {
    if (d.desired < MIN_POSITION) {
      prunedBelow += d.desired;
      d.desired = 0;
    }
  }

  // ── 7. Enforce MAX_SATELLITES count
  const sortedSurvivors = desired
    .filter((d) => d.desired > 0)
    .sort((a, b) => b.desired - a.desired);
  let prunedCount = 0;
  if (sortedSurvivors.length > MAX_SATELLITES) {
    for (let i = MAX_SATELLITES; i < sortedSurvivors.length; i++) {
      prunedCount += sortedSurvivors[i].desired;
      sortedSurvivors[i].desired = 0;
    }
  }

  // ── 8. Build final weight map; renormalize satellite sleeve to its target
  const totalSat = desired.reduce((s, d) => s + d.desired, 0);
  const weights: Record<string, number> = {};
  if (totalSat > 0) {
    const scale = params.satellites / totalSat;
    // We may have less than the target if tail was pruned aggressively;
    // in that case we DON'T scale up (extra goes to cash). Scaling up
    // would re-create concentration. Only scale DOWN if over.
    const finalScale = totalSat > params.satellites ? scale : 1.0;
    for (const d of desired) {
      if (d.desired > 0) weights[d.cand.asset_id] = d.desired * finalScale;
    }
  }

  // ── 9. Anchor: clamp BTC into [BTC_MIN, BTC_MAX]
  let btcW = Math.min(Math.max(params.btc, BTC_MIN), BTC_MAX);
  weights[input.btc_anchor_id] = btcW;

  // ── 10. Cash absorbs anything left over
  const sumNotional = Object.values(weights).reduce((s, x) => s + x, 0);
  const cash = Math.max(0, 1 - sumNotional);

  return {
    weights,
    cash_weight: cash,
    meta: {
      regime: input.regime,
      btc_target: params.btc,
      satellite_target: params.satellites,
      pruned_below_min: prunedBelow,
      pruned_cluster_cap: prunedCluster,
      pruned_max_count: prunedCount,
    },
  };
}
