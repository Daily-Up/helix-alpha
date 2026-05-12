/**
 * Attribution job — Part 3 wiring layer.
 *
 * Glues the pure attribution math (signal-attribution.ts) to the
 * persistence repo and the live rebalance flow. Two entry points:
 *
 *   1. recordAttributionAtRebalance — call right after a new rebalance
 *      lands. Computes the momentum-only counterfactual, diffs against
 *      the actual weights, persists a row that's "open" until the next
 *      rebalance resolves it.
 *
 *   2. resolvePendingAttributions — call right before recording a new
 *      rebalance. Looks up the last unresolved attribution row for the
 *      index, prices today's vs. that-rebalance-day prices, computes
 *      realized USD P&L per asset, and writes it back.
 *
 * Why this is decoupled from rebalance.ts: attribution must NEVER
 * affect live allocation. Keeping it in its own module makes that
 * boundary explicit — rebalance.ts catches any throw and continues.
 */

import { randomUUID } from "node:crypto";
import { IndexFund, db } from "@/lib/db";
import { computeCandidatePortfolio } from "@/lib/index-fund/weights";
import {
  computeAttribution,
  realizedAttributionPnL,
} from "./signal-attribution";

interface RecordInput {
  index_id: string;
  rebalance_id: string;
  /** What the live engine produced for this rebalance. */
  actual_weights: Record<string, number>;
  pre_nav_usd: number;
}

/**
 * Build the counterfactual using the same engine with `skipSignals: true`,
 * compute deltas, and persist. If the counterfactual fails the sanity
 * check we still write a row (sanity_ok=0) so the UI can surface "we
 * tried to compute attribution and it didn't pass — don't trust the
 * number." Better that than silently dropping diagnostics.
 */
export function recordAttributionAtRebalance(input: RecordInput): void {
  const cf = computeCandidatePortfolio({ skipSignals: true });
  const result = computeAttribution({
    asof_ms: Date.now(),
    actual_weights: input.actual_weights,
    counterfactual_weights: cf.weights,
    pre_nav_usd: input.pre_nav_usd,
  });

  IndexFund.insertSignalAttribution({
    id: randomUUID(),
    index_id: input.index_id,
    rebalance_id: input.rebalance_id,
    asof_ms: result.asof_ms,
    pre_nav_usd: input.pre_nav_usd,
    weight_deltas_bps: result.weight_deltas_bps,
    sanity_ok: result.sanity_ok,
    sanity_note: result.sanity_note ?? null,
  });
}

/**
 * Resolve open attribution rows for `indexId`. For each unresolved row
 * with sanity_ok=1, look up the close price at the row's asof date and
 * the most recent close, compute per-asset realized P&L, and write it
 * back. Rows missing klines on either end are left unresolved so a
 * later run can pick them up once data is available.
 */
export function resolvePendingAttributions(indexId: string): {
  resolved: number;
  skipped: number;
} {
  const open = IndexFund.listUnresolvedAttributions(indexId);
  let resolved = 0;
  let skipped = 0;

  const conn = db();
  // Latest close per asset (one row each)
  const latestCloseQuery = conn.prepare<[string], { date: string; close: number }>(
    `SELECT date, close FROM klines_daily
     WHERE asset_id = ?
     ORDER BY date DESC
     LIMIT 1`,
  );
  // Close on-or-before a date (closest historical price)
  const closeOnOrBeforeQuery = conn.prepare<
    [string, string],
    { close: number }
  >(
    `SELECT close FROM klines_daily
     WHERE asset_id = ? AND date <= ?
     ORDER BY date DESC
     LIMIT 1`,
  );

  for (const row of open) {
    if (Object.keys(row.weight_deltas_bps).length === 0) {
      // No deltas to resolve — close the row with zero P&L so it doesn't
      // sit forever (e.g. zero-signal rebalances or post-sanity-fail rows).
      IndexFund.resolveSignalAttribution(row.id, {}, 0, Date.now());
      resolved++;
      continue;
    }

    const asofDate = new Date(row.asof_ms).toISOString().slice(0, 10);
    const realized: Record<string, number> = {};
    let total = 0;
    let allHadPrices = true;

    for (const asset_id of Object.keys(row.weight_deltas_bps)) {
      const start = closeOnOrBeforeQuery.get(asset_id, asofDate);
      const end = latestCloseQuery.get(asset_id);
      if (!start || !end || start.close <= 0 || end.close <= 0) {
        allHadPrices = false;
        continue;
      }
      const pnl = realizedAttributionPnL(
        row.pre_nav_usd,
        row.weight_deltas_bps[asset_id],
        start.close,
        end.close,
      );
      realized[asset_id] = Math.round(pnl * 100) / 100;
      total += realized[asset_id];
    }

    if (!allHadPrices && Object.keys(realized).length === 0) {
      skipped++;
      continue;
    }
    IndexFund.resolveSignalAttribution(
      row.id,
      realized,
      Math.round(total * 100) / 100,
      Date.now(),
    );
    resolved++;
  }

  return { resolved, skipped };
}
