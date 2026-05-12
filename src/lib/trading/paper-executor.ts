/**
 * Paper-trade executor.
 *
 * Real SoDEX prices, simulated fills. Two entry points:
 *   • executeSignal(signalId) — turns a pending signal into an open trade
 *   • autoExecutePending()    — fires Tier-1 (auto) signals when settings allow
 *
 * Plus reconcileOpen() — checks every open position against live prices and
 * closes any that hit stop or target.
 */

import { randomUUID } from "node:crypto";
import {
  Assets,
  Outcomes,
  PaperTrades,
  Settings,
  Signals,
  type SignalRow,
} from "@/lib/db";
import { Market } from "@/lib/sodex";

interface ExecuteOptions {
  /** Override suggested size; default = signal.suggested_size_usd. */
  size_usd?: number;
  /** Override suggested stop %. */
  stop_pct?: number;
  /** Override suggested target %. */
  target_pct?: number;
  /** Reason logged in audit (manual_click / auto / api). */
  source?: "manual" | "auto" | "api";
}

export interface ExecutionResult {
  ok: boolean;
  signal_id: string;
  paper_trade_id?: string;
  error?: string;
}

/**
 * Execute one signal. Idempotent — calling twice just returns the
 * existing paper_trade.
 */
export async function executeSignal(
  signalId: string,
  options: ExecuteOptions = {},
): Promise<ExecutionResult> {
  const sig = Signals.getSignal(signalId);
  if (!sig) return { ok: false, signal_id: signalId, error: "signal not found" };
  if (sig.status === "executed" && sig.paper_trade_id) {
    return {
      ok: true,
      signal_id: signalId,
      paper_trade_id: sig.paper_trade_id,
    };
  }
  if (sig.status !== "pending") {
    return {
      ok: false,
      signal_id: signalId,
      error: `signal status is ${sig.status}, cannot execute`,
    };
  }

  const asset = Assets.getAssetById(sig.asset_id);
  if (!asset?.tradable) {
    return {
      ok: false,
      signal_id: signalId,
      error: "asset has no SoDEX trading pair",
    };
  }

  // Pull from spot + perps so we cover whichever market this asset trades on.
  const tickers = await Market.getAllTickersBySymbol();
  const t = tickers.get(sig.sodex_symbol);
  if (!t) {
    return {
      ok: false,
      signal_id: signalId,
      error: `no ticker for ${sig.sodex_symbol}`,
    };
  }
  const lastPx = Number(t.lastPx);
  if (!Number.isFinite(lastPx) || lastPx <= 0) {
    return {
      ok: false,
      signal_id: signalId,
      error: `invalid price for ${sig.sodex_symbol}`,
    };
  }

  const size_usd = options.size_usd ?? sig.suggested_size_usd ?? 500;
  const stop_pct = options.stop_pct ?? sig.suggested_stop_pct ?? 8;
  const target_pct = options.target_pct ?? sig.suggested_target_pct ?? 18;

  // Compute stop and target prices based on direction.
  const stop_price =
    sig.direction === "long"
      ? lastPx * (1 - stop_pct / 100)
      : lastPx * (1 + stop_pct / 100);
  const target_price =
    sig.direction === "long"
      ? lastPx * (1 + target_pct / 100)
      : lastPx * (1 - target_pct / 100);

  const tradeId = randomUUID();
  PaperTrades.insertTrade({
    id: tradeId,
    signal_id: sig.id,
    asset_id: sig.asset_id,
    sodex_symbol: sig.sodex_symbol,
    direction: sig.direction,
    size_usd,
    entry_price: lastPx,
    entry_time: Date.now(),
    stop_price,
    target_price,
  });

  Signals.markExecuted(sig.id, tradeId);

  return { ok: true, signal_id: sig.id, paper_trade_id: tradeId };
}

/** Dismiss a signal — user clicked ✕. */
export function dismissSignal(signalId: string): ExecutionResult {
  const sig = Signals.getSignal(signalId);
  if (!sig) return { ok: false, signal_id: signalId, error: "not found" };
  if (sig.status !== "pending") {
    return {
      ok: false,
      signal_id: signalId,
      error: `cannot dismiss ${sig.status}`,
    };
  }
  Signals.markDismissed(signalId);
  // Part 1 hook: record the dismissal in signal_outcomes immediately.
  // No-op if no outcome row exists (legacy pre-Part-1 signals).
  Outcomes.markOutcomeDismissed(signalId, "user_clicked_dismiss");
  return { ok: true, signal_id: signalId };
}

/**
 * Auto-execute every pending Tier-1 (auto) signal — but only if the user
 * has auto-trade enabled. Respects max_concurrent_positions + max_daily_trades.
 */
export async function autoExecutePending(): Promise<{
  executed: SignalRow[];
  skipped: number;
  reason: string | null;
}> {
  const settings = Settings.getSettings();
  if (!settings.auto_trade_enabled) {
    return {
      executed: [],
      skipped: 0,
      reason: "auto-trade disabled in settings",
    };
  }

  const open = PaperTrades.listOpen();
  if (open.length >= settings.max_concurrent_positions) {
    return {
      executed: [],
      skipped: 0,
      reason: "max_concurrent_positions reached",
    };
  }

  const pending = Signals.listSignals({ tier: "auto", status: "pending" });
  const executed: SignalRow[] = [];

  for (const s of pending) {
    if (open.length + executed.length >= settings.max_concurrent_positions) {
      break;
    }
    const result = await executeSignal(s.id, { source: "auto" });
    if (result.ok) executed.push(s);
  }

  return { executed, skipped: pending.length - executed.length, reason: null };
}

/**
 * Reconcile all open positions against live SoDEX prices.
 * Closes positions that hit their stop or target.
 */
export async function reconcileOpenPositions(): Promise<{
  checked: number;
  closed: number;
  reasons: Record<string, number>;
}> {
  const open = PaperTrades.listOpen();
  if (open.length === 0)
    return { checked: 0, closed: 0, reasons: {} };

  const tickers = await Market.getAllTickersBySymbol();
  let closedN = 0;
  const reasons: Record<string, number> = {};

  for (const t of open) {
    const ticker = tickers.get(t.sodex_symbol);
    if (!ticker) continue;
    const px = Number(ticker.lastPx);
    if (!Number.isFinite(px)) continue;

    let closeReason: "target" | "stop" | null = null;
    if (t.direction === "long") {
      if (t.target_price && px >= t.target_price) closeReason = "target";
      else if (t.stop_price && px <= t.stop_price) closeReason = "stop";
    } else {
      if (t.target_price && px <= t.target_price) closeReason = "target";
      else if (t.stop_price && px >= t.stop_price) closeReason = "stop";
    }

    if (closeReason) {
      PaperTrades.closeTrade(t.id, px, closeReason);
      closedN++;
      reasons[closeReason] = (reasons[closeReason] ?? 0) + 1;
    }
  }

  return { checked: open.length, closed: closedN, reasons };
}
