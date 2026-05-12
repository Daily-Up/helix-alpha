/**
 * GET/POST /api/cron/tick
 *
 * The master pipeline. Designed to be called every 5 minutes (by GitHub
 * Actions in production, or by the /signals "Live mode" toggle in dev).
 *
 * Steps:
 *   1. Ingest fresh news from SoSoValue (last 30 min) and classify new ones
 *   2. Generate tiered signals from new classifications
 *   3. Auto-execute Tier-1 signals if user has auto-trade enabled
 *   4. Reconcile open paper trades against live SoDEX prices
 *   5. Expire pending signals older than 6 hours
 *
 * Each step is idempotent. Returns a single summary so the UI / logs can
 * see what happened.
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { runNewsIngest } from "@/lib/ingest";
import {
  runSignalGen,
  autoExecutePending,
  reconcileOpenPositions,
} from "@/lib/trading";
import { Signals, Settings, Cron } from "@/lib/db";
import { rebalanceIndex } from "@/lib/index-fund";
import { runResolutionJob } from "@/lib/outcomes/resolve-job";
import { evaluateAlerts, isReadOnly } from "@/lib/system-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SIGNAL_EXPIRE_HOURS = 6;

async function handle(req: Request): Promise<NextResponse> {
  try {
    assertCronAuth(req);
  } catch (err) {
    return cronAuthErrorResponse(err);
  }

  const t0 = Date.now();
  const summary: Record<string, unknown> = {};

  // 1) Ingest news (last 30 min window — fast, picks up only fresh items)
  try {
    const ing = await runNewsIngest({ windowMs: 30 * 60 * 1000, maxItems: 80 });
    summary.ingest = {
      fetched: ing.fetched,
      new_events: ing.new_events,
      classified: ing.classified,
      errors: ing.classification_errors,
      cost_usd: ing.cost_usd,
    };
  } catch (err) {
    summary.ingest = { error: (err as Error).message };
  }

  // 2) Generate signals from any new classifications (look back 6h).
  //    Skipped entirely when READ_ONLY=true (Part 3) — the dashboard +
  //    outcome resolution still run during maintenance windows.
  if (isReadOnly()) {
    summary.signal_gen = { skipped: "READ_ONLY mode active" };
  } else {
    try {
      const gen = await runSignalGen({ lookbackHours: 6 });
      summary.signal_gen = {
        created: gen.signals_created,
        by_tier: gen.by_tier,
        skipped_stale: gen.signals_skipped_stale_event,
        skipped_not_actionable: gen.signals_skipped_not_actionable,
        skipped_below_threshold: gen.signals_skipped_below_threshold,
      };
    } catch (err) {
      summary.signal_gen = { error: (err as Error).message };
    }
  }

  // 3) Auto-execute Tier-1 if enabled
  try {
    const auto = await autoExecutePending();
    summary.auto_execute = {
      executed: auto.executed.length,
      skipped: auto.skipped,
      reason: auto.reason,
    };
  } catch (err) {
    summary.auto_execute = { error: (err as Error).message };
  }

  // 4) Reconcile open positions against live prices
  try {
    const rec = await reconcileOpenPositions();
    summary.reconcile = rec;
  } catch (err) {
    summary.reconcile = { error: (err as Error).message };
  }

  // 5) Expire stale pending signals — two-pronged:
  //    a) signal fired_at older than SIGNAL_EXPIRE_HOURS (clock-based)
  //    b) underlying news older than MAX_NEWS_AGE_HOURS regardless of
  //       when the signal itself fired (catches "purge+regen revives
  //       dead alpha" pattern — MSTR/UBS bug)
  try {
    const expiredBySignal = Signals.expirePendingOlderThan(
      SIGNAL_EXPIRE_HOURS * 60 * 60 * 1000,
    );
    const MAX_NEWS_AGE_HOURS = 24;
    const expiredByNews = Signals.expirePendingByNewsAge(
      MAX_NEWS_AGE_HOURS * 60 * 60 * 1000,
    );
    summary.expired = {
      by_signal_age: expiredBySignal,
      by_news_age: expiredByNews,
    };
  } catch (err) {
    summary.expired = { error: (err as Error).message };
  }

  // 6) Rebalance AlphaIndex if auto-rebalance is enabled. We don't run
  // every tick — once per day-ish — but let it skip in v1 since cost is
  // low ($0.05/rebalance with Claude review).
  try {
    const settings = Settings.getSettings();
    if (settings.index_auto_rebalance) {
      const rb = await rebalanceIndex("alphacore", {
        triggered_by: "scheduled",
      });
      summary.index_rebalance = {
        trades: rb.trades.length,
        pre_nav: rb.pre_nav,
        post_nav: rb.post_nav,
        reasoning: rb.reasoning.slice(0, 200),
      };
    } else {
      summary.index_rebalance = { skipped: "auto-rebalance disabled" };
    }
  } catch (err) {
    summary.index_rebalance = { error: (err as Error).message };
  }

  // 7) Outcome resolution (Part 1). Runs every tick — the job itself is
  //    cheap (only touches outcome rows where outcome IS NULL). We wrap
  //    it in Cron.recordRun so /system-health can detect staleness.
  try {
    const { data: resolution } = await Cron.recordRun(
      "resolve_outcomes",
      async () => {
        const r = runResolutionJob();
        return {
          summary: `pending=${r.pending_before} target_hit=${r.resolved_target_hit} stop_hit=${r.resolved_stop_hit} flat=${r.resolved_flat} still_pending=${r.still_pending}`,
          data: r,
        };
      },
    );
    summary.outcome_resolution = resolution;
  } catch (err) {
    summary.outcome_resolution = { error: (err as Error).message };
  }

  // 8) Evaluate system-health alert thresholds (Part 3). Idempotent —
  //    Alerts.raiseAlert coalesces duplicates within 1h.
  try {
    const raised = evaluateAlerts();
    summary.alerts_raised = raised.length;
  } catch (err) {
    summary.alerts_raised = { error: (err as Error).message };
  }

  return NextResponse.json({
    ok: true,
    latency_ms: Date.now() - t0,
    summary,
  });
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
