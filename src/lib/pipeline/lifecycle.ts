/**
 * Stage 8 — Signal lifecycle.
 *
 * Each signal carries an `expiresAt` (when its reaction window closes)
 * and an optional `corroboration_deadline` (when a single-source rumor
 * must be backed up by a second source or auto-dismiss).
 *
 * Both are derived from the catalyst subtype + source tier at the time
 * the signal is generated. They're stored on the row; a periodic
 * sweeper (or pre-fetch hook on the active queue) reads them and marks
 * pending signals expired with a typed dismiss reason.
 *
 * This replaces the previous coarse "expire after 6h" rule with
 * subtype-aware decay. Real example fixed: an MSTR/UBS rumor sat in
 * pending for 22h on a single tweet because:
 *   1. The signal generator kept refiring on it as long as the news
 *      was within 36h.
 *   2. The 6h auto-expire fired but the next gen run resurrected.
 * With subtype-aware expiresAt + corroboration_deadline = 4h, the
 * single-source rumor gets dismissed cleanly.
 *
 * Companion tests: tests/lifecycle.test.ts
 */

import type {
  CatalystSubtype,
  DismissReason,
  SignalLifecycle,
  SourceTier,
} from "./types";
import { riskProfileForSubtype } from "./catalyst-subtype";

interface ComputeLifecycleInput {
  subtype: CatalystSubtype;
  generated_at: number; // ms epoch — usually Date.now()
  source_tier: SourceTier;
  /** Optional: external override for `event_chain_id`. */
  event_chain_id?: string | null;
}

/**
 * Build the lifecycle metadata for a new signal.
 *
 * Rules:
 *   - expires_at = generated_at + horizon_ms from the subtype profile.
 *   - corroboration_deadline = generated_at + 4h, but ONLY when
 *     source_tier > 1 (Bloomberg/SEC don't need corroboration).
 *   - Subtypes with >24h horizons get longer corroboration deadlines
 *     (8h for treasury_action, regulatory_statement) since the news
 *     cycle around them takes longer.
 */
export function computeLifecycle(input: ComputeLifecycleInput): SignalLifecycle {
  const profile = riskProfileForSubtype(input.subtype, null);
  const expires_at = input.generated_at + profile.horizon_ms;

  let corroboration_deadline: number | null = null;
  if (input.source_tier > 1) {
    // Slow-burn catalysts get a longer corroboration window.
    const slowBurn = new Set<CatalystSubtype>([
      "regulatory_statement",
      "treasury_action",
      "macro_print",
      "macro_geopolitical",
      "fundraising_announcement",
      "tech_update",
      "etf_flow_reaction",
    ]);
    const corrobMs = slowBurn.has(input.subtype)
      ? 8 * 3600 * 1000
      : 4 * 3600 * 1000;
    corroboration_deadline = input.generated_at + corrobMs;
  }

  return {
    expires_at,
    corroboration_deadline,
    event_chain_id: input.event_chain_id ?? null,
  };
}

interface ExpireCheckInput {
  status: "pending" | "executed" | "dismissed" | "expired";
  expires_at: number;
  corroboration_deadline: number | null;
  /** Number of corroborating sources known at check time. */
  corroboration_count_at_check: number;
  /** Override for testability; defaults to Date.now(). */
  now?: number;
}

export interface ExpireCheckResult {
  expire: boolean;
  reason?: DismissReason;
}

/**
 * Decide whether to expire a single signal. Idempotent — called by
 * the periodic sweeper. Only mutates pending signals.
 */
export function shouldExpireSignal(
  input: ExpireCheckInput,
): ExpireCheckResult {
  if (input.status !== "pending") return { expire: false };
  const now = input.now ?? Date.now();

  if (now >= input.expires_at) {
    return { expire: true, reason: "stale_unexecuted" };
  }
  if (
    input.corroboration_deadline != null &&
    now >= input.corroboration_deadline &&
    input.corroboration_count_at_check === 0
  ) {
    return { expire: true, reason: "uncorroborated" };
  }
  return { expire: false };
}
