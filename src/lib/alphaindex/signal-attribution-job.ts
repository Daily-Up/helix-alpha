/**
 * Attribution job — Part 3 wiring layer. Wave 2: async.
 */

import { randomUUID } from "node:crypto";
import { IndexFund, get } from "@/lib/db";
import { computeCandidatePortfolio } from "@/lib/index-fund/weights";
import {
  computeAttribution,
  realizedAttributionPnL,
} from "./signal-attribution";

interface RecordInput {
  index_id: string;
  rebalance_id: string;
  actual_weights: Record<string, number>;
  pre_nav_usd: number;
}

export async function recordAttributionAtRebalance(
  input: RecordInput,
): Promise<void> {
  const cf = await computeCandidatePortfolio({ skipSignals: true });
  const result = computeAttribution({
    asof_ms: Date.now(),
    actual_weights: input.actual_weights,
    counterfactual_weights: cf.weights,
    pre_nav_usd: input.pre_nav_usd,
  });

  await IndexFund.insertSignalAttribution({
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

export async function resolvePendingAttributions(
  indexId: string,
): Promise<{ resolved: number; skipped: number }> {
  const open = await IndexFund.listUnresolvedAttributions(indexId);
  let resolved = 0;
  let skipped = 0;

  for (const row of open) {
    if (Object.keys(row.weight_deltas_bps).length === 0) {
      await IndexFund.resolveSignalAttribution(row.id, {}, 0, Date.now());
      resolved++;
      continue;
    }

    const asofDate = new Date(row.asof_ms).toISOString().slice(0, 10);
    const realized: Record<string, number> = {};
    let total = 0;
    let allHadPrices = true;

    for (const asset_id of Object.keys(row.weight_deltas_bps)) {
      const start = await get<{ close: number }>(
        `SELECT close FROM klines_daily
         WHERE asset_id = ? AND date <= ?
         ORDER BY date DESC LIMIT 1`,
        [asset_id, asofDate],
      );
      const end = await get<{ date: string; close: number }>(
        `SELECT date, close FROM klines_daily
         WHERE asset_id = ?
         ORDER BY date DESC LIMIT 1`,
        [asset_id],
      );
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
    await IndexFund.resolveSignalAttribution(
      row.id,
      realized,
      Math.round(total * 100) / 100,
      Date.now(),
    );
    resolved++;
  }

  return { resolved, skipped };
}
