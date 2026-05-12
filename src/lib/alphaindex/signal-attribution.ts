/**
 * Signal P&L attribution — Part 3.
 *
 * "Did the news-signal layer add or subtract value vs. plain momentum?"
 *
 * Per rebalance we compute two weight vectors:
 *   1. ACTUAL — what the live engine produced (anchors × momentum × signal)
 *   2. COUNTERFACTUAL — what the same inputs would produce with all
 *      signal scores zeroed (anchors × momentum × 1.0)
 *
 * The delta (actual − counterfactual) per asset is the "signal-driven
 * weight tilt." Multiplying that delta by the realized return between
 * rebalance T and T+1 yields the attribution P&L of the signal layer.
 *
 * Sanity guard: if the counterfactual is malformed (sums to >100%, has
 * negative weights, etc.) we ZERO OUT the attribution rather than
 * display nonsense. Better silent than misleading.
 *
 * Companion tests: tests/signal-attribution.test.ts.
 */

// ─────────────────────────────────────────────────────────────────────────
// Pure attribution math
// ─────────────────────────────────────────────────────────────────────────

export interface AttributionInputs {
  asof_ms: number;
  /** Live-engine weights at this rebalance, asset_id → fraction. */
  actual_weights: Record<string, number>;
  /** Same inputs but with all signal scores set to 0 → momentum-only. */
  counterfactual_weights: Record<string, number>;
  pre_nav_usd: number;
}

export interface AttributionResult {
  asof_ms: number;
  pre_nav_usd: number;
  /** asset_id → (actual − counterfactual) in basis points (rounded int). */
  weight_deltas_bps: Record<string, number>;
  /** False = counterfactual was garbage and we zeroed everything. */
  sanity_ok: boolean;
  /** Human-readable note for the UI when sanity_ok is false. */
  sanity_note?: string;
}

/**
 * Compute weight deltas. Refuses to emit deltas if the counterfactual
 * doesn't pass basic sanity checks — see file-level note for why.
 */
export function computeAttribution(input: AttributionInputs): AttributionResult {
  const cfValues = Object.values(input.counterfactual_weights);
  const cfSum = cfValues.reduce((s, x) => s + x, 0);
  const hasNegative = cfValues.some((x) => x < -1e-9);
  // Allow tiny float drift; refuse anything materially over 100%.
  const exceedsOne = cfSum > 1.001;
  // Tolerate near-zero (a totally cash portfolio is valid even if odd).
  const sanity_ok = !hasNegative && !exceedsOne;

  if (!sanity_ok) {
    return {
      asof_ms: input.asof_ms,
      pre_nav_usd: input.pre_nav_usd,
      weight_deltas_bps: {},
      sanity_ok: false,
      sanity_note: hasNegative
        ? "counterfactual contains negative weights"
        : `counterfactual weights sum to ${(cfSum * 100).toFixed(1)}%`,
    };
  }

  const allAssets = new Set<string>([
    ...Object.keys(input.actual_weights),
    ...Object.keys(input.counterfactual_weights),
  ]);
  const deltas: Record<string, number> = {};
  for (const a of allAssets) {
    const actual = input.actual_weights[a] ?? 0;
    const cf = input.counterfactual_weights[a] ?? 0;
    const dw = actual - cf;
    // Drop sub-bps drift; only record meaningful tilts.
    if (Math.abs(dw) >= 1e-5) {
      deltas[a] = Math.round(dw * 10000);
    }
  }

  return {
    asof_ms: input.asof_ms,
    pre_nav_usd: input.pre_nav_usd,
    weight_deltas_bps: deltas,
    sanity_ok: true,
  };
}

/**
 * Realized P&L of a single weight delta over a price interval.
 *
 *   pnl = pre_nav × (delta_w_bps / 1e4) × (px_end / px_start − 1)
 *
 * Defensive on bad inputs: returns 0 for non-positive prices or NAV.
 * The sign convention is intuitive: positive delta with positive return
 * = positive P&L (signal helped). Negative delta with negative return
 * also = positive P&L (avoided drawdown).
 */
export function realizedAttributionPnL(
  pre_nav_usd: number,
  weight_delta_bps: number,
  px_start: number,
  px_end: number,
): number {
  if (pre_nav_usd <= 0 || px_start <= 0 || px_end <= 0) return 0;
  const dw = weight_delta_bps / 10_000;
  const ret = px_end / px_start - 1;
  return pre_nav_usd * dw * ret;
}

// ─────────────────────────────────────────────────────────────────────────
// Aggregator (for the UI panel)
// ─────────────────────────────────────────────────────────────────────────

export interface AttributionRow {
  asset_id: string;
  weight_delta_bps: number;
  pnl_usd: number;
}

export interface AttributionSummary {
  total_pnl_usd: number;
  winners: AttributionRow[]; // sorted by descending pnl_usd
  losers: AttributionRow[];  // sorted by ascending pnl_usd
}

/** Tally per-asset attribution rows into a summary. */
export function attributionSummary(rows: AttributionRow[]): AttributionSummary {
  const total = rows.reduce((s, r) => s + r.pnl_usd, 0);
  const winners = rows
    .filter((r) => r.pnl_usd > 0)
    .sort((a, b) => b.pnl_usd - a.pnl_usd);
  const losers = rows
    .filter((r) => r.pnl_usd < 0)
    .sort((a, b) => a.pnl_usd - b.pnl_usd);
  return { total_pnl_usd: total, winners, losers };
}
