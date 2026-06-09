/**
 * Pure outcome-resolution logic — Part 1.
 *
 * Resolution is measured AT EXPIRY. We only return a terminal verdict
 * once `now > expires_at`; before that the signal is still `pending`
 * (the resolution job retries later). This matters because the realized
 * number is the *expiry-time* ROI, which can't be known until the
 * horizon has actually elapsed.
 *
 * Two distinct things come out of a resolved signal:
 *
 *   1. `outcome` — a LABEL describing what happened during the holding
 *      window between `generated_at` and `expires_at`:
 *        target_hit  — price touched the target level intraday
 *        stop_hit    — price touched the stop level intraday
 *        flat        — neither level was touched
 *      Same-day collision rule: if a single bar's range contains BOTH
 *      target and stop, we label it `stop_hit` (pessimistic /
 *      walk-forward-defensive — a real fill engine sizes the loss before
 *      chasing the upside).
 *
 *   2. `realized_pct` — the return you'd actually be holding. This is the
 *      directional close-to-close ROI from `price_at_generation` to the
 *      expiry-day close, BUT bounded by the bracket: it can never exceed
 *      `+target_pct` (the take-profit would have filled) nor fall below
 *      `-stop_pct` (the stop-loss would have filled). So:
 *        - inside the band  → the real expiry-day ROI (an intermediate
 *          number, NOT always the fixed target/stop)
 *        - outside the band → clamped to +target_pct / -stop_pct
 *      `price_at_outcome` is the raw expiry-day close (pre-clamp) for
 *      transparency.
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

  // Realized ROI is an expiry-time measurement: stay pending until the
  // horizon has actually elapsed. We never resolve early on an intraday
  // touch, because touching a level isn't an exit — the position rides
  // to expiry and the realized number is whatever it closes at then.
  if (now <= signal.expires_at) {
    return {
      outcome: null,
      outcome_at_ms: null,
      price_at_outcome: null,
      realized_pct: null,
    };
  }

  // Without an anchor price we can't compute levels or ROI. Expiry has
  // passed → flat with no PnL info.
  if (price_at_generation == null || price_at_generation <= 0) {
    return {
      outcome: "flat",
      outcome_at_ms: signal.expires_at,
      price_at_outcome: null,
      realized_pct: 0,
    };
  }

  // Concrete price levels — used ONLY to label the outcome.
  const targetPrice =
    direction === "long"
      ? price_at_generation * (1 + target_pct / 100)
      : price_at_generation * (1 - target_pct / 100);
  const stopPrice =
    direction === "long"
      ? price_at_generation * (1 - stop_pct / 100)
      : price_at_generation * (1 + stop_pct / 100);

  // Bars inside the holding window [generated_at, expires_at].
  const inWindow = klines
    .filter((k) => k.ts_ms >= signal.generated_at && k.ts_ms <= signal.expires_at)
    .sort((a, b) => a.ts_ms - b.ts_ms);

  // ── 1. Label: did price touch target/stop during the window? ────────
  let outcome: ResolutionOutcome = "flat";
  let labelTs: number | null = null;
  for (const bar of inWindow) {
    const targetHit =
      direction === "long" ? bar.high >= targetPrice : bar.low <= targetPrice;
    const stopHit =
      direction === "long" ? bar.low <= stopPrice : bar.high >= stopPrice;

    if (stopHit) {
      // Pessimistic: if both touched the same day, the stop wins.
      outcome = "stop_hit";
      labelTs = bar.ts_ms;
      break;
    }
    if (targetHit) {
      outcome = "target_hit";
      labelTs = bar.ts_ms;
      break;
    }
  }

  // ── 2. Realized: ALWAYS close-to-close ROI at expiry ────────────────
  const lastBar =
    inWindow.length > 0
      ? inWindow[inWindow.length - 1]
      : klines[klines.length - 1];
  if (!lastBar) {
    // No price data at all but expiry passed → keep the label, no PnL.
    return {
      outcome,
      outcome_at_ms: signal.expires_at,
      price_at_outcome: null,
      realized_pct: 0,
    };
  }
  const finalPx = lastBar.close;
  const rawMove =
    ((finalPx - price_at_generation) / price_at_generation) * 100;
  const directional = direction === "long" ? rawMove : -rawMove;
  // Bracket bound: the position would have exited at the take-profit or
  // stop-loss, so realized PnL can't surpass +target_pct / -stop_pct.
  const bounded = Math.min(Math.max(directional, -stop_pct), target_pct);
  return {
    outcome,
    // When a level was touched, surface the touch day; otherwise expiry.
    outcome_at_ms: outcome === "flat" ? signal.expires_at : labelTs,
    price_at_outcome: finalPx,
    realized_pct: Number(bounded.toFixed(2)),
  };
}
