/**
 * v2 — bounded signal integration (Fix 6).
 *
 * News signals influence weights, but with strict bounds so the
 * structural framework (regime + concentration + anchor) is always
 * recognizable in the final book.
 *
 * Bounds (also enforced as I-33 / I-34):
 *   - Each signal moves a SATELLITE weight by ≤ ±2% absolute (I-34)
 *   - BTC anchor cannot be pushed outside [40%, 70%] band (I-33)
 *   - In DRAWDOWN regime, ONLY bearish/risk-off signals are honored;
 *     bullish signals are QUEUED for application when regime exits.
 *
 * The "queue" is informational here — we return the queued list so
 * the engine / UI can show it. Persistence of the queue across
 * rebalances is the engine's job.
 *
 * Companion tests: tests/alphaindex-v2/signal-integration.test.ts.
 */

import type { Regime } from "./regime";
import { BTC_MIN, BTC_MAX } from "./allocator";

/** Maximum absolute weight change per signal (I-34). */
export const MAX_SIGNAL_BOOST = 0.02;

export interface SignalEntry {
  asset_id: string;
  /** Aggregated signed score; positive = bullish, negative = bearish. */
  signed_score: number;
}

export interface SignalBoostInput {
  base_weights: Record<string, number>;
  base_cash: number;
  signals: SignalEntry[];
  regime: Regime;
  btc_anchor_id: string;
}

export interface SignalBoostResult {
  weights: Record<string, number>;
  cash_weight: number;
  /** Signals that were not applied because the regime gated them. */
  queued_signals: SignalEntry[];
}

/**
 * Map a signed score in roughly [-∞, ∞] to a delta in [-MAX, +MAX]
 * via tanh saturation. A score of ~1 already moves halfway to the cap;
 * extreme scores saturate near the cap.
 */
function scoreToDelta(score: number): number {
  return MAX_SIGNAL_BOOST * Math.tanh(score / 1.5);
}

export function applySignalBoosts(input: SignalBoostInput): SignalBoostResult {
  const out: Record<string, number> = { ...input.base_weights };
  const queued: SignalEntry[] = [];

  for (const sig of input.signals) {
    // Regime gating: in DRAWDOWN, queue bullish signals (do not apply).
    if (input.regime === "DRAWDOWN" && sig.signed_score > 0) {
      queued.push(sig);
      continue;
    }

    const delta = scoreToDelta(sig.signed_score);
    const before = out[sig.asset_id] ?? 0;
    let next = before + delta;

    // BTC-anchor band enforcement (I-33).
    if (sig.asset_id === input.btc_anchor_id) {
      next = Math.min(Math.max(next, BTC_MIN), BTC_MAX);
    } else {
      // Floor at 0 — never go negative on a satellite.
      next = Math.max(0, next);
    }
    out[sig.asset_id] = next;
  }

  // Re-derive cash from sum.
  const sumNotional = Object.values(out).reduce((s, x) => s + x, 0);
  const cash = Math.max(0, 1 - sumNotional);

  return {
    weights: out,
    cash_weight: cash,
    queued_signals: queued,
  };
}
