/**
 * Resolution job — Part 1. Wave 2: async.
 */

import { all, get, Outcomes } from "@/lib/db";
import {
  resolveOutcome,
  type DailyKline,
  type ResolveSignalInput,
} from "./resolve";

export interface ResolutionJobResult {
  pending_before: number;
  resolved_target_hit: number;
  resolved_stop_hit: number;
  resolved_flat: number;
  still_pending: number;
  skipped_no_prices: number;
  errors: number;
  /** Flat outcomes whose `realized_pct` we backfilled from fresh klines
   *  because the original resolution ran while klines_daily was stale
   *  (price_at_outcome was NULL). */
  flats_repriced: number;
  /** Signals that had no signal_outcomes row at all (slipped through
   *  the insertOutcomeFromSignal wiring at fire time) and were
   *  backfilled in this run. */
  stragglers_backfilled: number;
}

export async function runResolutionJob(
  opts: { now?: number } = {},
): Promise<ResolutionJobResult> {
  const now = opts.now ?? Date.now();

  // Pass 0: catch signals whose insertOutcomeFromSignal call failed at
  // fire time (transient DB hiccup, etc.) — they wouldn't appear in
  // listPendingOutcomes because there's no row at all. Run the
  // backfill first so the rest of the resolver sees them.
  let stragglersBackfilled = 0;
  try {
    const r = await backfillOutcomesForExistingSignals();
    stragglersBackfilled = r.inserted;
  } catch (err) {
    console.warn(
      `[resolve-job] straggler backfill failed: ${(err as Error).message}`,
    );
  }

  const pending = await Outcomes.listPendingOutcomes();
  const result: ResolutionJobResult = {
    pending_before: pending.length,
    resolved_target_hit: 0,
    resolved_stop_hit: 0,
    resolved_flat: 0,
    still_pending: 0,
    skipped_no_prices: 0,
    errors: 0,
    flats_repriced: 0,
    stragglers_backfilled: stragglersBackfilled,
  };

  for (const row of pending) {
    try {
      const klines = await klinesForWindow(row.asset_id, row.generated_at, now);
      if (klines.length === 0 && now <= row.expires_at) {
        result.skipped_no_prices++;
        result.still_pending++;
        continue;
      }
      const signal: ResolveSignalInput = {
        asset_id: row.asset_id,
        direction: row.direction,
        price_at_generation: row.price_at_generation,
        target_pct: row.target_pct,
        stop_pct: row.stop_pct,
        generated_at: row.generated_at,
        expires_at: row.expires_at,
      };
      const verdict = resolveOutcome({ signal, klines, now });
      if (verdict.outcome == null) {
        result.still_pending++;
        continue;
      }
      await Outcomes.applyResolution(row.signal_id, {
        outcome: verdict.outcome,
        outcome_at_ms: verdict.outcome_at_ms ?? now,
        price_at_outcome: verdict.price_at_outcome,
        realized_pct: verdict.realized_pct,
      });
      if (verdict.outcome === "target_hit") result.resolved_target_hit++;
      else if (verdict.outcome === "stop_hit") result.resolved_stop_hit++;
      else if (verdict.outcome === "flat") result.resolved_flat++;
    } catch (err) {
      result.errors++;
      console.warn(
        `[resolve-job] error on ${row.signal_id}: ${(err as Error).message}`,
      );
    }
  }

  // Second pass: re-resolve flat outcomes whose `price_at_outcome` is
  // NULL. Those rows were resolved while klines_daily was stale and
  // are stuck at `realized_pct=0` — a placeholder, not a real flat.
  // Now that klines are fresh we can compute the actual directional
  // close-to-close ROI at expiry.
  try {
    const flats = await Outcomes.listFlatOutcomesMissingPrice();
    for (const row of flats) {
      try {
        const klines = await klinesForWindow(
          row.asset_id,
          row.generated_at,
          row.expires_at,
        );
        if (klines.length === 0) continue;
        const signal: ResolveSignalInput = {
          asset_id: row.asset_id,
          direction: row.direction,
          price_at_generation: row.price_at_generation,
          target_pct: row.target_pct,
          stop_pct: row.stop_pct,
          generated_at: row.generated_at,
          expires_at: row.expires_at,
        };
        const verdict = resolveOutcome({
          signal,
          klines,
          // Pin "now" to past-expiry so we always get a terminal verdict.
          now: row.expires_at + 1,
        });
        if (verdict.outcome == null) continue;
        await Outcomes.recomputeFlatResolution(row.signal_id, {
          outcome: verdict.outcome,
          outcome_at_ms: verdict.outcome_at_ms ?? row.expires_at,
          price_at_outcome: verdict.price_at_outcome,
          realized_pct: verdict.realized_pct,
        });
        result.flats_repriced++;
      } catch (err) {
        result.errors++;
        console.warn(
          `[resolve-job] reprice error on ${row.signal_id}: ${(err as Error).message}`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[resolve-job] flat-reprice pass failed: ${(err as Error).message}`,
    );
  }

  return result;
}

export async function backfillOutcomesForExistingSignals(): Promise<{
  inserted: number;
  skipped_no_asset_class: number;
  skipped_no_klines: number;
}> {
  interface SigRow {
    id: string;
    asset_id: string;
    fired_at: number;
  }
  const stragglers = await all<SigRow>(
    `SELECT s.id, s.asset_id, s.fired_at
     FROM signals s
     LEFT JOIN signal_outcomes o ON o.signal_id = s.id
     WHERE o.signal_id IS NULL`,
  );

  const out = {
    inserted: 0,
    skipped_no_asset_class: 0,
    skipped_no_klines: 0,
  };

  for (const sig of stragglers) {
    interface AssetRow {
      kind: string;
      symbol: string;
    }
    const a = await get<AssetRow>(
      `SELECT kind, symbol FROM assets WHERE id = ?`,
      [sig.asset_id],
    );
    if (!a) {
      out.skipped_no_asset_class++;
      continue;
    }
    const klines = await klinesForWindow(sig.asset_id, sig.fired_at, Date.now());
    if (klines.length === 0) {
      out.skipped_no_klines++;
      continue;
    }
    const catalystPrice =
      (await priceAtOrBefore(sig.asset_id, sig.fired_at)) ??
      klines[0]?.close ??
      null;

    try {
      await Outcomes.insertOutcomeFromSignal({
        signal_id: sig.id,
        asset_class: classifyForBackfill(a),
        price_at_generation: catalystPrice,
      });
      out.inserted++;
    } catch (err) {
      console.warn(
        `[backfill] failed for ${sig.id}: ${(err as Error).message}`,
      );
    }
  }
  return out;
}

async function klinesForWindow(
  assetId: string,
  fromMs: number,
  toMs: number,
): Promise<DailyKline[]> {
  const fromDate = new Date(fromMs).toISOString().slice(0, 10);
  const toDate = new Date(toMs).toISOString().slice(0, 10);
  interface Row {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
  }
  const rows = await all<Row>(
    `SELECT date, open, high, low, close FROM klines_daily
     WHERE asset_id = ? AND date >= ? AND date <= ?
     ORDER BY date ASC`,
    [assetId, fromDate, toDate],
  );
  return rows.map((r) => ({
    asset_id: assetId,
    date: r.date,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    ts_ms: Date.UTC(
      Number(r.date.slice(0, 4)),
      Number(r.date.slice(5, 7)) - 1,
      Number(r.date.slice(8, 10)),
    ),
  }));
}

async function priceAtOrBefore(
  assetId: string,
  ts: number,
): Promise<number | null> {
  const date = new Date(ts).toISOString().slice(0, 10);
  const r = await get<{ close: number }>(
    `SELECT close FROM klines_daily
     WHERE asset_id = ? AND date <= ?
     ORDER BY date DESC LIMIT 1`,
    [assetId, date],
  );
  return r && r.close > 0 ? r.close : null;
}

function classifyForBackfill(a: { kind: string; symbol: string }): string {
  const s = a.symbol.toUpperCase();
  if (a.kind === "token" || a.kind === "rwa") {
    if (["BTC", "ETH"].includes(s)) return "large_cap_crypto";
    if (
      ["SOL", "XRP", "BNB", "ADA", "DOT", "AVAX", "DOGE", "TRX", "LINK", "LTC", "ARB", "OP"].includes(
        s,
      )
    )
      return "mid_cap_crypto";
    return "small_cap_crypto";
  }
  if (a.kind === "stock" || a.kind === "treasury") {
    const cryptoAdj = [
      "COIN", "MSTR", "MARA", "RIOT", "HOOD", "CIFR", "IREN", "CLSK",
      "HUT", "BLOCK", "GLXY", "WULF", "CRCL", "XYZ",
    ];
    return cryptoAdj.includes(s) ? "crypto_adjacent_equity" : "broad_equity";
  }
  if (a.kind === "etf" || a.kind === "etf_fund" || a.kind === "etf_aggregate") {
    return "large_cap_crypto";
  }
  return "small_cap_crypto";
}
