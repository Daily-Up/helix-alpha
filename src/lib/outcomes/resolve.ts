/**
 * Pure outcome-resolution logic — Part 1.
 *
 * Walks a chronological daily-kline series for the asset between
 * `signal.generated_at` and `min(now, signal.expires_at)` and decides:
 *
 *   target_hit  — high crossed target_price (long) or low crossed target_price (short)
 *   stop_hit    — low crossed stop_price (long) or high crossed stop_price (short)
 *   flat        — neither hit AND now > expires_at; realized_pct from final close
 *   pending     — neither hit AND now ≤ expires_at; resolution job retries later
 *
 * Same-day collision rule: if a single bar's range contains BOTH target
 * and stop, we mark it `stop_hit`. Pessimistic / walk-forward-defensive —
 * matches how a real fill engine would size the loss before chasing the
 * upside.
 *
 * Companion tests: tests/outcomes.test.ts.
 *
 * Invariants: I-30 (PIPELINE_INVARIANTS.md).
 */

export interface DailyKline {
  asset_id: string;
  /** YYYY-MM-DD UTC. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Bar's start-of-day timestamp in ms. */
  ts_ms: number;
}

export interface ResolveSignalInput {
  asset_id: string;
  direction: "long" | "short";
  /** Catalyst-time spot price. NULL when not priceable; we still resolve
   *  flat at expiry but realized_pct = 0 since we have no anchor. */
  price_at_generation: number | null;
  target_pct: number;
  stop_pct: number;
  generated_at: number;
  expires_at: number;
}

export interface ResolveInput {
  signal: ResolveSignalInput;
  klines: DailyKline[];
  /** Override "now" for testing; defaults to Date.now(). */
  now?: number;
}

export type ResolutionOutcome =
  | "target_hit"
  | "stop_hit"
  | "flat"
  | null;

export interface ResolutionResult {
  /** null = still pending; caller leaves the row's `outcome` column as NULL. */
  outcome: ResolutionOutcome;
  /** ms-epoch when the outcome was decided (target/stop crossing day, or expiry). */
  outcome_at_ms: number | null;
  price_at_outcome: number | null;
  /** Signed: positive = profit on the predicted direction. */
  realized_pct: number | null;
}

/**
 * Walk klines chronologically. Returns the resolution result.
 */
export function resolveOutcome(input: ResolveInput): ResolutionResult {
  const { signal, klines } = input;
  const now = input.now ?? Date.now();
  const { direction, price_at_generation, target_pct, stop_pct } = signal;

  // Without an anchor price we can't compute target/stop levels. We can
  // still mark `flat` once horizon expires (realized_pct = 0).
  if (price_at_generation == null || price_at_generation <= 0) {
    if (now > signal.expires_at) {
      return {
        outcome: "flat",
        outcome_at_ms: signal.expires_at,
        price_at_outcome: null,
        realized_pct: 0,
      };
    }
    return {
      outcome: null,
      outcome_at_ms: null,
      price_at_outcome: null,
      realized_pct: null,
    };
  }

  // Concrete price levels.
  const targetPrice =
    direction === "long"
      ? price_at_generation * (1 + target_pct / 100)
      : price_at_generation * (1 - target_pct / 100);
  const stopPrice =
    direction === "long"
      ? price_at_generation * (1 - stop_pct / 100)
      : price_at_generation * (1 + stop_pct / 100);

  // Filter to bars in the window [generated_at, min(now, expires_at)].
  const upperBound = Math.min(now, signal.expires_at);
  const inWindow = klines
    .filter((k) => k.ts_ms >= signal.generated_at && k.ts_ms <= upperBound)
    .sort((a, b) => a.ts_ms - b.ts_ms);

  for (const bar of inWindow) {
    const targetHit =
      direction === "long" ? bar.high >= targetPrice : bar.low <= targetPrice;
    const stopHit =
      direction === "long" ? bar.low <= stopPrice : bar.high >= stopPrice;

    if (targetHit && stopHit) {
      // Pessimistic: assume stop fired first.
      return {
        outcome: "stop_hit",
        outcome_at_ms: bar.ts_ms,
        price_at_outcome: stopPrice,
        realized_pct: -stop_pct,
      };
    }
    if (targetHit) {
      return {
        outcome: "target_hit",
        outcome_at_ms: bar.ts_ms,
        price_at_outcome: targetPrice,
        realized_pct: target_pct,
      };
    }
    if (stopHit) {
      return {
        outcome: "stop_hit",
        outcome_at_ms: bar.ts_ms,
        price_at_outcome: stopPrice,
        realized_pct: -stop_pct,
      };
    }
  }

  // No hit yet — flat if expiry passed, otherwise still pending.
  if (now > signal.expires_at) {
    const lastBar =
      inWindow.length > 0
        ? inWindow[inWindow.length - 1]
        : klines[klines.length - 1];
    if (!lastBar) {
      // No price data and expiry passed → flat with no PnL info.
      return {
        outcome: "flat",
        outcome_at_ms: signal.expires_at,
        price_at_outcome: null,
        realized_pct: 0,
      };
    }
    const finalPx = lastBar.close;
    const rawMove =
      ((finalPx - price_at_generation) / price_at_generation) * 100;
    const directional = direction === "long" ? rawMove : -rawMove;
    return {
      outcome: "flat",
      outcome_at_ms: signal.expires_at,
      price_at_outcome: finalPx,
      realized_pct: Number(directional.toFixed(2)),
    };
  }

  return {
    outcome: null,
    outcome_at_ms: null,
    price_at_outcome: null,
    realized_pct: null,
  };
}
