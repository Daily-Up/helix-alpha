/**
 * Resolution job — Part 1.
 *
 * Walks `signal_outcomes WHERE outcome IS NULL`, fetches the price
 * window from klines_daily, and applies the pure `resolveOutcome` to
 * each. Verdicts:
 *
 *   target_hit / stop_hit / flat → applyResolution writes the outcome
 *   pending                       → leave NULL, retry next run
 *
 * Designed to run every 15 minutes (call site: src/jobs/resolve-outcomes.ts
 * via the existing cron tick). Idempotent.
 *
 * Backfill: same code path. `runResolutionJob` returns counts; callers
 * can call it once at boot to backfill historical signals.
 */

import { db, Outcomes } from "@/lib/db";
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
}

/**
 * Run one pass of the resolution job. Pure orchestration on top of the
 * pure `resolveOutcome` and the outcomes repo.
 */
export function runResolutionJob(
  opts: { now?: number } = {},
): ResolutionJobResult {
  const now = opts.now ?? Date.now();
  const pending = Outcomes.listPendingOutcomes();
  const result: ResolutionJobResult = {
    pending_before: pending.length,
    resolved_target_hit: 0,
    resolved_stop_hit: 0,
    resolved_flat: 0,
    still_pending: 0,
    skipped_no_prices: 0,
    errors: 0,
  };

  for (const row of pending) {
    try {
      const klines = klinesForWindow(row.asset_id, row.generated_at, now);
      if (klines.length === 0 && now <= row.expires_at) {
        // No price data yet AND horizon hasn't passed — wait.
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
      Outcomes.applyResolution(row.signal_id, {
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
  return result;
}

/**
 * Backfill outcomes for signals that fired BEFORE the outcomes table
 * existed. For each pending signal that lacks an outcome row, insert
 * the row, then run the resolution pass.
 *
 * Skips signals whose asset has no klines_daily history at all.
 */
export function backfillOutcomesForExistingSignals(): {
  inserted: number;
  skipped_no_asset_class: number;
  skipped_no_klines: number;
} {
  interface SigRow {
    id: string;
    asset_id: string;
    fired_at: number;
  }
  const stragglers = db()
    .prepare<[], SigRow>(
      `SELECT s.id, s.asset_id, s.fired_at
       FROM signals s
       LEFT JOIN signal_outcomes o ON o.signal_id = s.id
       WHERE o.signal_id IS NULL`,
    )
    .all();

  const out = {
    inserted: 0,
    skipped_no_asset_class: 0,
    skipped_no_klines: 0,
  };

  for (const sig of stragglers) {
    // Resolve asset class. Pulled here to avoid a circular import on
    // signal-generator's `classifyAssetClass` import path.
    interface AssetRow {
      kind: string;
      symbol: string;
    }
    const a = db()
      .prepare<[string], AssetRow>(
        `SELECT kind, symbol FROM assets WHERE id = ?`,
      )
      .get(sig.asset_id);
    if (!a) {
      out.skipped_no_asset_class++;
      continue;
    }
    const klines = klinesForWindow(sig.asset_id, sig.fired_at, Date.now());
    if (klines.length === 0) {
      out.skipped_no_klines++;
      continue;
    }
    // priceAtOrBefore for fire time — fall back to first available kline.
    const catalystPrice =
      priceAtOrBefore(sig.asset_id, sig.fired_at) ?? klines[0]?.close ?? null;

    try {
      Outcomes.insertOutcomeFromSignal({
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

// ─────────────────────────────────────────────────────────────────────────
// Helpers — klines fetch + asset_class lookup duplicated locally to avoid
// pulling signal-generator into the outcomes module
// ─────────────────────────────────────────────────────────────────────────

function klinesForWindow(
  assetId: string,
  fromMs: number,
  toMs: number,
): DailyKline[] {
  const fromDate = new Date(fromMs).toISOString().slice(0, 10);
  const toDate = new Date(toMs).toISOString().slice(0, 10);
  interface Row {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
  }
  const rows = db()
    .prepare<[string, string, string], Row>(
      `SELECT date, open, high, low, close FROM klines_daily
       WHERE asset_id = ? AND date >= ? AND date <= ?
       ORDER BY date ASC`,
    )
    .all(assetId, fromDate, toDate);
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

function priceAtOrBefore(assetId: string, ts: number): number | null {
  const date = new Date(ts).toISOString().slice(0, 10);
  const r = db()
    .prepare<[string, string], { close: number }>(
      `SELECT close FROM klines_daily
       WHERE asset_id = ? AND date <= ?
       ORDER BY date DESC LIMIT 1`,
    )
    .get(assetId, date);
  return r && r.close > 0 ? r.close : null;
}

/** Local copy of the simple asset_class classifier used by base-rates.
 *  Intentionally NOT imported from base-rates so the backfill can run
 *  in isolation. Falls back to "small_cap_crypto" / "broad_equity" when
 *  the symbol isn't in the curated lists. */
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
