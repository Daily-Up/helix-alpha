/**
 * Repository — `signals` table.
 *
 * Tiered signals fired by the engine. The /signals UI groups by tier:
 *   • tier='auto'   — high-conviction, can fire automatically
 *   • tier='review' — medium-conviction, surfaces for one-click approval
 *   • tier='info'   — low-conviction, informational only
 */

import { db } from "../client";

export type SignalTier = "auto" | "review" | "info";
export type SignalStatus =
  | "pending"
  | "executed"
  | "dismissed"
  | "expired"
  | "suppressed" // Phase D — lost a same-asset opposite-direction conflict at emission
  | "superseded"; // Phase E — replaced by a stronger (≥1.5× significance) opposite-direction signal
export type SignalDirection = "long" | "short";

export interface SignalRow {
  id: string;
  fired_at: number;
  triggered_by_event_id: string | null;
  pattern_id: string | null;
  asset_id: string;
  sodex_symbol: string;
  direction: SignalDirection;
  tier: SignalTier;
  status: SignalStatus;
  confidence: number;
  expected_impact_pct: number | null;
  expected_horizon: string | null;
  suggested_size_usd: number | null;
  suggested_stop_pct: number | null;
  suggested_target_pct: number | null;
  reasoning: string;
  /** JSON array of asset_ids the same event also affected — kept for
   *  UI display ("also affected: BTC, MAG7"). NULL on legacy rows. */
  secondary_asset_ids: string | null;
  // ── Pipeline metadata (nullable on legacy rows pre-pipeline-wiring) ──
  /** Fine-grained catalyst subtype from src/lib/pipeline/catalyst-subtype.ts. */
  catalyst_subtype: string | null;
  /** ms epoch when this signal goes stale (lifecycle sweeper auto-dismisses). */
  expires_at: number | null;
  /** ms epoch by which a single-source signal needs ≥1 corroborating outlet. */
  corroboration_deadline: number | null;
  /** Hash binding signals on the same evolving story together. */
  event_chain_id: string | null;
  /** Primary asset's relevance score [0..1] from asset-router. */
  asset_relevance: number | null;
  /** Promotional/shill score [0..1] from promotional detector. */
  promotional_score: number | null;
  /** 1=tier-1 outlet, 2=tier-2, 3=KOL/anon. */
  source_tier: number | null;
  executed_at: number | null;
  dismissed_at: number | null;
  /** Typed reason when status is 'dismissed' or 'expired'. */
  dismiss_reason: string | null;
  paper_trade_id: string | null;
  /** Phase C — composite significance score [0..1]. */
  significance_score: number | null;
  /** Phase E — pointer to the signal that retired this one (status='superseded'). */
  superseded_by_signal_id: string | null;
  /** Phase D/E — ms epoch at which the window was cut short. */
  effective_end_at: number | null;
}

export type NewSignal = Omit<
  SignalRow,
  | "fired_at"
  | "status"
  | "executed_at"
  | "dismissed_at"
  | "dismiss_reason"
  | "paper_trade_id"
  | "superseded_by_signal_id"
  | "effective_end_at"
>;

export function insertSignal(s: NewSignal): SignalRow {
  const fired_at = Date.now();
  db()
    .prepare(
      `INSERT INTO signals (
         id, fired_at, triggered_by_event_id, pattern_id, asset_id,
         sodex_symbol, direction, tier, status, confidence,
         expected_impact_pct, expected_horizon,
         suggested_size_usd, suggested_stop_pct, suggested_target_pct,
         reasoning, secondary_asset_ids,
         catalyst_subtype, expires_at, corroboration_deadline,
         event_chain_id, asset_relevance, promotional_score, source_tier,
         significance_score
       ) VALUES (
         @id, @fired_at, @triggered_by_event_id, @pattern_id, @asset_id,
         @sodex_symbol, @direction, @tier, 'pending', @confidence,
         @expected_impact_pct, @expected_horizon,
         @suggested_size_usd, @suggested_stop_pct, @suggested_target_pct,
         @reasoning, @secondary_asset_ids,
         @catalyst_subtype, @expires_at, @corroboration_deadline,
         @event_chain_id, @asset_relevance, @promotional_score, @source_tier,
         @significance_score
       )`,
    )
    .run({
      ...s,
      fired_at,
      secondary_asset_ids: s.secondary_asset_ids ?? null,
      catalyst_subtype: s.catalyst_subtype ?? null,
      expires_at: s.expires_at ?? null,
      corroboration_deadline: s.corroboration_deadline ?? null,
      event_chain_id: s.event_chain_id ?? null,
      asset_relevance: s.asset_relevance ?? null,
      promotional_score: s.promotional_score ?? null,
      source_tier: s.source_tier ?? null,
      significance_score: s.significance_score ?? null,
    });
  return getSignal(s.id)!;
}

/**
 * Phase D/E — mark a signal as suppressed (lost a strict conflict at
 * emission) or superseded (replaced by ≥1.5× significance opposite). The
 * status flip ends the window at `effective_end_at = now()`, after which
 * lifecycle code treats the row as terminal.
 */
export function markSuppressed(id: string, supersedingId: string | null): void {
  db()
    .prepare(
      `UPDATE signals
         SET status='suppressed',
             effective_end_at=?,
             superseded_by_signal_id=?
       WHERE id=?`,
    )
    .run(Date.now(), supersedingId, id);
}

export function markSupersededByConflict(
  id: string,
  supersedingId: string,
): void {
  db()
    .prepare(
      `UPDATE signals
         SET status='superseded',
             effective_end_at=?,
             superseded_by_signal_id=?
       WHERE id=?`,
    )
    .run(Date.now(), supersedingId, id);
}

export function getSignal(id: string): SignalRow | undefined {
  return db()
    .prepare<[string], SignalRow>("SELECT * FROM signals WHERE id = ?")
    .get(id);
}

/** Recent signals for the /signals page. Pending first, then executed/dismissed. */
export function listSignals(opts?: {
  tier?: SignalTier;
  status?: SignalStatus;
  limit?: number;
}): SignalRow[] {
  const limit = opts?.limit ?? 100;
  const wheres: string[] = [];
  const params: Array<string | number> = [];
  if (opts?.tier) {
    wheres.push("tier = ?");
    params.push(opts.tier);
  }
  if (opts?.status) {
    wheres.push("status = ?");
    params.push(opts.status);
  }
  let sql = "SELECT * FROM signals";
  if (wheres.length) sql += ` WHERE ${wheres.join(" AND ")}`;
  sql += " ORDER BY fired_at DESC LIMIT ?";
  params.push(limit);
  return db().prepare<typeof params, SignalRow>(sql).all(...params);
}

export function markExecuted(id: string, paperTradeId: string): void {
  db()
    .prepare(
      `UPDATE signals SET status = 'executed', executed_at = ?, paper_trade_id = ? WHERE id = ?`,
    )
    .run(Date.now(), paperTradeId, id);
}

export function markDismissed(id: string, reason?: string): void {
  if (reason) {
    db()
      .prepare(
        `UPDATE signals SET status = 'dismissed', dismissed_at = ?, dismiss_reason = ? WHERE id = ?`,
      )
      .run(Date.now(), reason, id);
  } else {
    db()
      .prepare(
        `UPDATE signals SET status = 'dismissed', dismissed_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
  }
}

/**
 * Lifecycle sweeper — mark pending signals expired when:
 *   - now >= expires_at (reason: stale_unexecuted), OR
 *   - now >= corroboration_deadline AND no corroborating sources yet
 *     (reason: uncorroborated)
 *
 * Idempotent: only touches status='pending' rows. Returns count expired.
 */
export function sweepExpiredSignals(now: number = Date.now()): {
  stale_unexecuted: number;
  uncorroborated: number;
} {
  // Stale: past expires_at.
  const staleResult = db()
    .prepare(
      `UPDATE signals
       SET status = 'expired',
           dismissed_at = ?,
           dismiss_reason = 'stale_unexecuted'
       WHERE status = 'pending'
         AND expires_at IS NOT NULL
         AND expires_at <= ?`,
    )
    .run(now, now);

  // Uncorroborated: past corroboration_deadline AND no duplicates pointing
  // at the underlying event. (Corroboration count = duplicate_of count
  // for the triggering news event.)
  //
  // Source-tier gate: ONLY apply this rule to tier-3 sources (KOL/anon).
  // Tier-1 (Bloomberg/SEC/Reuters/official) and tier-2 (PANews/Decrypt/
  // CoinDesk/etc.) are recognised outlets — single coverage from them is
  // a real signal and doesn't need a sibling outlet to confirm. Without
  // this gate, legitimate signals on tech_update, regulatory_action, or
  // exchange-listing events from primary sources were getting killed
  // after 8h just because no one re-tweeted the story.
  //
  // NULL source_tier (legacy rows pre-pipeline-wiring) is also exempt
  // so historical signals aren't retroactively swept.
  const uncorroboratedResult = db()
    .prepare(
      `UPDATE signals
       SET status = 'expired',
           dismissed_at = ?,
           dismiss_reason = 'uncorroborated'
       WHERE status = 'pending'
         AND corroboration_deadline IS NOT NULL
         AND corroboration_deadline <= ?
         AND triggered_by_event_id IS NOT NULL
         AND source_tier = 3
         AND (
           SELECT COUNT(*) FROM news_events
           WHERE duplicate_of = signals.triggered_by_event_id
         ) = 0`,
    )
    .run(now, now);

  return {
    stale_unexecuted: staleResult.changes,
    uncorroborated: uncorroboratedResult.changes,
  };
}

/** Has this event already produced a signal for this asset? Avoids duplicates. */
export function existsForEventAsset(
  eventId: string,
  assetId: string,
): boolean {
  // Only count ACTIVE signals (pending or executed). Including expired
  // / dismissed / superseded creates a subtle bug: after a purge+regen
  // cycle, the prior gen's old expired signals block new attempts on
  // the same (event, asset) — forcing the generator to fall through to
  // less-precise asset choices.
  //
  // Real example caught in May 2026: Mantle DAO governance event had
  // two expired tok-aave LONG signals from earlier gen runs. New gen
  // tried tok-aave first (correct primary by sort), got blocked by
  // those expired rows, fell through to idx-ssidefi. The DeFi-index
  // signal that resulted diluted the alpha that was actually in AAVE.
  // Include 'superseded' alongside 'pending' / 'executed': a superseded
  // signal represents that we DID process this event, just got replaced
  // by a stronger one. Re-firing on it would create duplicate coverage.
  // 'expired' and 'dismissed' are excluded so purge+regen still works
  // and operator-dismissed events can be re-tried after fresh evidence.
  const r = db()
    .prepare<[string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM signals
       WHERE triggered_by_event_id = ? AND asset_id = ?
         AND status IN ('pending', 'executed', 'superseded')`,
    )
    .get(eventId, assetId);
  return (r?.n ?? 0) > 0;
}

/**
 * Has any recent (different) event produced a signal for the same
 * (asset, direction, event_type) within `windowMs`?
 *
 * Catches duplicate signals when multiple outlets cover the same story
 * (e.g. Upbit + Bithumb + others all reporting the same Pharos listing).
 */
export function existsRecentForAssetDirection(
  assetId: string,
  direction: "long" | "short",
  eventType: string,
  windowMs: number,
): boolean {
  const cutoff = Date.now() - windowMs;
  const r = db()
    .prepare<[string, string, number, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM signals s
       LEFT JOIN classifications c ON c.event_id = s.triggered_by_event_id
       WHERE s.asset_id = ?
         AND s.direction = ?
         AND s.fired_at >= ?
         AND s.status IN ('pending', 'executed')
         AND COALESCE(c.event_type, '') = ?`,
    )
    .get(assetId, direction, cutoff, eventType);
  return (r?.n ?? 0) > 0;
}

/**
 * Mark all pending signals older than `olderThanMs` as `expired`.
 * Uses signal fired_at — the signal generator's clock for "when did
 * I fire this?". Returns number of rows affected. Idempotent.
 */
export function expirePendingOlderThan(olderThanMs: number): number {
  const cutoff = Date.now() - olderThanMs;
  const result = db()
    .prepare(
      `UPDATE signals SET status = 'expired'
       WHERE status = 'pending' AND fired_at < ?`,
    )
    .run(cutoff);
  return result.changes;
}

/**
 * Mark pending signals as expired based on the UNDERLYING NEWS EVENT'S
 * age, not the signal's fire time. Catches the "purge + regenerate
 * keeps reviving stale alpha" pattern where a signal repeatedly fires
 * on a 24-48h-old news event.
 *
 * The MSTR/UBS bug demonstrated this: news from 22h ago kept producing
 * fresh "REVIEW SHORT 72%" signals because each gen run set fired_at
 * to now. From a trader's view that's dead alpha — the move (if real)
 * has already happened.
 */
export function expirePendingByNewsAge(maxNewsAgeMs: number): number {
  const cutoff = Date.now() - maxNewsAgeMs;
  const result = db()
    .prepare(
      `UPDATE signals SET status = 'expired'
       WHERE status = 'pending'
         AND triggered_by_event_id IN (
           SELECT id FROM news_events WHERE release_time < ?
         )`,
    )
    .run(cutoff);
  return result.changes;
}

/**
 * Find pending signals on this asset with the SAME direction. Used to
 * enforce "max one pending signal per (asset, direction)" — multiple
 * events firing the same direction on the same asset collapse to the
 * highest conviction one.
 *
 * NOTE: deliberately direction-scoped. Opposite-direction signals are
 * handled separately by `findOppositePendingForAsset` because they
 * represent a REAL disagreement between catalysts that needs explicit
 * conflict resolution, not a cap.
 *
 * History: an earlier version returned any-direction matches, which
 * blocked legitimate opposite-direction signals. E.g., MSTR SHORT from
 * UBS-exits-position news blocked MSTR LONG from JPMorgan-Strategy-buys
 * news — and the generator fell through to firing on idx-ssimag7
 * instead, diluting the alpha.
 */
export function findSameDirectionPendingForAsset(
  assetId: string,
  direction: "long" | "short",
): SignalRow[] {
  return db()
    .prepare<[string, string], SignalRow>(
      `SELECT * FROM signals
       WHERE status = 'pending' AND asset_id = ? AND direction = ?
       ORDER BY confidence DESC`,
    )
    .all(assetId, direction);
}

/** @deprecated — use `findSameDirectionPendingForAsset` instead.
 *  Returns all pending signals on the asset regardless of direction.
 *  Kept temporarily for any callers that genuinely need any-direction. */
export function findAllPendingForAsset(assetId: string): SignalRow[] {
  return db()
    .prepare<[string], SignalRow>(
      `SELECT * FROM signals
       WHERE status = 'pending' AND asset_id = ?
       ORDER BY confidence DESC`,
    )
    .all(assetId);
}

/**
 * Find pending signals from the last `windowMs` that match the given
 * (event_type, direction). This is the AGGRESSIVE story-cluster dedup:
 *
 * Within a single 12h window, we treat all signals sharing the same
 * (event_type, direction) as ONE narrative cluster. Examples:
 *   - LayerZero security stories firing SHORTs on ENA, ARB, OP →
 *     all same security/short cluster → keep strongest only.
 *   - Multiple regulatory-long stories (SEC, CLARITY Act, etc.) →
 *     all same regulatory/long cluster → keep strongest only.
 *   - Multiple earnings shorts (COIN, HOOD) on the Coinbase Q1 print →
 *     same earnings/short cluster → keep strongest only.
 *
 * Trade-off: two genuinely distinct events of the same type+direction
 * in the same 12h window will collapse. We accept this because:
 *   (a) for a trader, "the bullish regulatory thesis" needs ONE signal,
 *       not 8 correlated longs;
 *   (b) the dashboard is the user's surface, and 30 signals from one
 *       narrative is "broken UX" no matter how technically distinct.
 *
 * Returns matches ordered by confidence DESC so callers compare against
 * the strongest existing.
 */
export function findStoryOverlap(opts: {
  asset_ids: string[]; // accepted but currently unused (see note below)
  event_type: string;
  direction: "long" | "short";
  window_ms: number;
}): Array<SignalRow & { covered: string[] }> {
  // Note: we intentionally IGNORE asset overlap here. Same event_type +
  // direction within 12h is treated as the same narrative cluster.
  // A previous Jaccard ≥ 0.5 check missed cases like LayerZero-security
  // events whose primary assets (ENA/ARB/OP) shared no common id.
  void opts.asset_ids;

  const cutoff = Date.now() - opts.window_ms;
  // Reuses the SignalRow shape — every column on `signals` is included.
  const candidates = db()
    .prepare<[number, string, string], SignalRow>(
      `SELECT s.* FROM signals s
       LEFT JOIN classifications c ON c.event_id = s.triggered_by_event_id
       WHERE s.status = 'pending'
         AND s.fired_at >= ?
         AND s.direction = ?
         AND COALESCE(c.event_type, '') = ?
       ORDER BY s.confidence DESC`,
    )
    .all(cutoff, opts.direction, opts.event_type);

  return candidates.map((row) => ({
    ...row,
    covered: [
      row.asset_id,
      ...(row.secondary_asset_ids
        ? (JSON.parse(row.secondary_asset_ids) as string[])
        : []),
    ],
  }));
}

/**
 * Find a pending signal on the same asset with the OPPOSITE direction.
 * Used for conflict detection during signal generation — if returned,
 * resolve via "higher conviction wins".
 */
export function findOppositePendingForAsset(
  assetId: string,
  newDirection: "long" | "short",
): SignalRow | undefined {
  const opposite = newDirection === "long" ? "short" : "long";
  return db()
    .prepare<[string, string], SignalRow>(
      `SELECT * FROM signals
       WHERE status = 'pending'
         AND asset_id = ?
         AND direction = ?
       ORDER BY confidence DESC
       LIMIT 1`,
    )
    .get(assetId, opposite);
}

/**
 * Find ALL pending signals for an asset (any direction). Used by the
 * UI to render conflict badges when there's disagreement.
 */
export function pendingForAsset(assetId: string): SignalRow[] {
  return db()
    .prepare<[string], SignalRow>(
      `SELECT * FROM signals
       WHERE status = 'pending' AND asset_id = ?
       ORDER BY fired_at DESC`,
    )
    .all(assetId);
}

/** Mark a signal as `superseded` because a higher-conviction one replaced it.
 *
 *  Status semantics:
 *    - 'expired'    → time-based expiry by the lifecycle sweeper
 *    - 'superseded' → replaced by a stronger signal on the same story
 *    - 'dismissed'  → operator action
 *  Previously this set status='expired' which collided with time-based
 *  expiry semantics and made the `existsForEventAsset` dedup unable to
 *  distinguish "we processed this and replaced it" from "we processed
 *  this and let the clock run out" — leading to re-fires on the same
 *  event_id when supersedings were rolled back upstream.
 */
export function markSuperseded(id: string, supersededBy: string): void {
  db()
    .prepare(
      `UPDATE signals
       SET status = 'superseded',
           effective_end_at = unixepoch() * 1000,
           superseded_by_signal_id = ?,
           reasoning = 'Superseded by signal ' || ? || '. ' || COALESCE(reasoning, '')
       WHERE id = ? AND status = 'pending'`,
    )
    .run(supersededBy, supersededBy, id);
}
