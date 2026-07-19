/**
 * Repository — `signals` table.
 * Wave 2: async (libSQL/Turso). `result.changes` becomes `result.rowsAffected`.
 */

import { all, get, run } from "../client";

export type SignalTier = "auto" | "review" | "info";
export type SignalStatus =
  | "pending"
  | "executed"
  | "dismissed"
  | "expired"
  | "suppressed"
  | "superseded";
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
  secondary_asset_ids: string | null;
  catalyst_subtype: string | null;
  expires_at: number | null;
  corroboration_deadline: number | null;
  event_chain_id: string | null;
  asset_relevance: number | null;
  promotional_score: number | null;
  source_tier: number | null;
  executed_at: number | null;
  dismissed_at: number | null;
  dismiss_reason: string | null;
  paper_trade_id: string | null;
  significance_score: number | null;
  superseded_by_signal_id: string | null;
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

export async function insertSignal(s: NewSignal): Promise<SignalRow> {
  const fired_at = Date.now();
  await run(
    `INSERT INTO signals (
       id, fired_at, triggered_by_event_id, pattern_id, asset_id,
       sodex_symbol, direction, tier, status, confidence,
       expected_impact_pct, expected_horizon,
       suggested_size_usd, suggested_stop_pct, suggested_target_pct,
       reasoning, secondary_asset_ids,
       catalyst_subtype, expires_at, corroboration_deadline,
       event_chain_id, asset_relevance, promotional_score, source_tier,
       significance_score
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.id,
      fired_at,
      s.triggered_by_event_id,
      s.pattern_id,
      s.asset_id,
      s.sodex_symbol,
      s.direction,
      s.tier,
      s.confidence,
      s.expected_impact_pct,
      s.expected_horizon,
      s.suggested_size_usd,
      s.suggested_stop_pct,
      s.suggested_target_pct,
      s.reasoning,
      s.secondary_asset_ids ?? null,
      s.catalyst_subtype ?? null,
      s.expires_at ?? null,
      s.corroboration_deadline ?? null,
      s.event_chain_id ?? null,
      s.asset_relevance ?? null,
      s.promotional_score ?? null,
      s.source_tier ?? null,
      s.significance_score ?? null,
    ],
  );
  return (await getSignal(s.id))!;
}

export async function markSuppressed(
  id: string,
  supersedingId: string | null,
): Promise<void> {
  await run(
    `UPDATE signals
       SET status='suppressed', effective_end_at=?, superseded_by_signal_id=?
     WHERE id=?`,
    [Date.now(), supersedingId, id],
  );
}

export async function markSupersededByConflict(
  id: string,
  supersedingId: string,
): Promise<void> {
  await run(
    `UPDATE signals
       SET status='superseded', effective_end_at=?, superseded_by_signal_id=?
     WHERE id=?`,
    [Date.now(), supersedingId, id],
  );
}

export async function getSignal(id: string): Promise<SignalRow | undefined> {
  return get<SignalRow>("SELECT * FROM signals WHERE id = ?", [id]);
}

export async function listSignals(opts?: {
  tier?: SignalTier;
  status?: SignalStatus;
  limit?: number;
}): Promise<SignalRow[]> {
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
  return all<SignalRow>(sql, params);
}

export async function markExecuted(
  id: string,
  paperTradeId: string,
): Promise<void> {
  await run(
    `UPDATE signals SET status = 'executed', executed_at = ?, paper_trade_id = ? WHERE id = ?`,
    [Date.now(), paperTradeId, id],
  );
}

export async function markDismissed(
  id: string,
  reason?: string,
): Promise<void> {
  if (reason) {
    await run(
      `UPDATE signals SET status = 'dismissed', dismissed_at = ?, dismiss_reason = ? WHERE id = ?`,
      [Date.now(), reason, id],
    );
  } else {
    await run(
      `UPDATE signals SET status = 'dismissed', dismissed_at = ? WHERE id = ?`,
      [Date.now(), id],
    );
  }
}

export async function sweepExpiredSignals(
  now: number = Date.now(),
): Promise<{ stale_unexecuted: number; uncorroborated: number }> {
  const staleResult = await run(
    `UPDATE signals
     SET status = 'expired',
         dismissed_at = ?,
         dismiss_reason = 'stale_unexecuted'
     WHERE status = 'pending'
       AND expires_at IS NOT NULL
       AND expires_at <= ?`,
    [now, now],
  );

  const uncorroboratedResult = await run(
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
    [now, now],
  );

  return {
    stale_unexecuted: Number(staleResult.rowsAffected),
    uncorroborated: Number(uncorroboratedResult.rowsAffected),
  };
}

export async function existsForEventAsset(
  eventId: string,
  assetId: string,
): Promise<boolean> {
  // INTENT: "Did we EVER fire (or even attempt to fire) a signal for this
  // exact event×asset pair?" If yes, never fire again — same news on the
  // same asset is by definition a duplicate, regardless of what happened
  // to the prior signal (it may have expired in the lifecycle sweep,
  // been dismissed, executed, or blocked at the invariant gate).
  //
  // Previous bug: gated on `status IN ('pending', 'executed', 'superseded')`,
  // which let the same event_id refire after the lifecycle sweeper moved
  // the prior signal to 'expired' (regulatory_statement signals expire
  // within ~30 min). Real instance on prod: tok-btc long regulatory event
  // 20618347 fired 4× in 3.5h on 2026-06-03 because each successor came
  // after the predecessor had already been swept to 'expired'.
  const r = await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM signals
     WHERE triggered_by_event_id = ? AND asset_id = ?`,
    [eventId, assetId],
  );
  return (r?.n ?? 0) > 0;
}

export async function existsForEventChain(
  eventChainId: string,
): Promise<boolean> {
  // INTENT: "Did we EVER fire a signal for this exact event chain?" Used by
  // sources that have no triggering news_event (e.g. the calendar-driven
  // token-unlock generator, where `triggered_by_event_id` is null and the
  // stable key is `event_chain_id = "unlock:<slug>-<date>"`). Idempotent
  // across daily reruns regardless of the prior signal's status.
  const r = await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM signals WHERE event_chain_id = ?`,
    [eventChainId],
  );
  return (r?.n ?? 0) > 0;
}

export async function existsRecentForAssetDirection(
  assetId: string,
  direction: "long" | "short",
  eventType: string,
  windowMs: number,
): Promise<boolean> {
  // INTENT: "Within the last `windowMs`, did we already fire any signal
  // for this (asset, direction, event_type) combination?" Same news cycle
  // typically produces 5-10 outlets covering the same catalyst within
  // hours; the first signal is the trade, the rest are noise.
  //
  // Status filter REMOVED for the same reason as `existsForEventAsset`:
  // a signal that fired 1h ago and was swept to 'expired' by the
  // subtype-aware lifecycle still counts — we already took our shot at
  // this story. Including 'blocked' too: if the invariant gate rejected
  // a prior attempt, we shouldn't keep retrying the same idea.
  const cutoff = Date.now() - windowMs;
  const r = await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM signals s
     LEFT JOIN classifications c ON c.event_id = s.triggered_by_event_id
     WHERE s.asset_id = ?
       AND s.direction = ?
       AND s.fired_at >= ?
       AND COALESCE(c.event_type, '') = ?`,
    [assetId, direction, cutoff, eventType],
  );
  return (r?.n ?? 0) > 0;
}

export async function expirePendingOlderThan(
  olderThanMs: number,
): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  const result = await run(
    `UPDATE signals SET status = 'expired'
     WHERE status = 'pending' AND fired_at < ?`,
    [cutoff],
  );
  return Number(result.rowsAffected);
}

export async function expirePendingByNewsAge(
  maxNewsAgeMs: number,
): Promise<number> {
  const cutoff = Date.now() - maxNewsAgeMs;
  const result = await run(
    `UPDATE signals SET status = 'expired'
     WHERE status = 'pending'
       AND triggered_by_event_id IN (
         SELECT id FROM news_events WHERE release_time < ?
       )`,
    [cutoff],
  );
  return Number(result.rowsAffected);
}

export async function findSameDirectionPendingForAsset(
  assetId: string,
  direction: "long" | "short",
): Promise<SignalRow[]> {
  return all<SignalRow>(
    `SELECT * FROM signals
     WHERE status = 'pending' AND asset_id = ? AND direction = ?
     ORDER BY confidence DESC`,
    [assetId, direction],
  );
}

/** @deprecated — use findSameDirectionPendingForAsset. */
export async function findAllPendingForAsset(
  assetId: string,
): Promise<SignalRow[]> {
  return all<SignalRow>(
    `SELECT * FROM signals
     WHERE status = 'pending' AND asset_id = ?
     ORDER BY confidence DESC`,
    [assetId],
  );
}

export async function findStoryOverlap(opts: {
  asset_ids: string[];
  event_type: string;
  direction: "long" | "short";
  window_ms: number;
}): Promise<Array<SignalRow & { covered: string[] }>> {
  void opts.asset_ids;
  const cutoff = Date.now() - opts.window_ms;
  const candidates = await all<SignalRow>(
    `SELECT s.* FROM signals s
     LEFT JOIN classifications c ON c.event_id = s.triggered_by_event_id
     WHERE s.status = 'pending'
       AND s.fired_at >= ?
       AND s.direction = ?
       AND COALESCE(c.event_type, '') = ?
     ORDER BY s.confidence DESC`,
    [cutoff, opts.direction, opts.event_type],
  );

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

export async function findOppositePendingForAsset(
  assetId: string,
  newDirection: "long" | "short",
): Promise<SignalRow | undefined> {
  const opposite = newDirection === "long" ? "short" : "long";
  return get<SignalRow>(
    `SELECT * FROM signals
     WHERE status = 'pending' AND asset_id = ? AND direction = ?
     ORDER BY confidence DESC
     LIMIT 1`,
    [assetId, opposite],
  );
}

export async function pendingForAsset(assetId: string): Promise<SignalRow[]> {
  return all<SignalRow>(
    `SELECT * FROM signals
     WHERE status = 'pending' AND asset_id = ?
     ORDER BY fired_at DESC`,
    [assetId],
  );
}

export async function markSuperseded(
  id: string,
  supersededBy: string,
): Promise<void> {
  await run(
    `UPDATE signals
     SET status = 'superseded',
         effective_end_at = unixepoch() * 1000,
         superseded_by_signal_id = ?,
         reasoning = 'Superseded by signal ' || ? || '. ' || COALESCE(reasoning, '')
     WHERE id = ? AND status = 'pending'`,
    [supersededBy, supersededBy, id],
  );
}
