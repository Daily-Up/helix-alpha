/**
 * POST /api/public/run-tick
 *
 * PUBLIC, UNAUTHENTICATED endpoint for the "⟳ Tick now" button on
 * /signals. Runs the master pipeline (the same work /api/cron/tick
 * does) with a 2-min rate limit.
 *
 * The GitHub Actions cron already pokes /api/cron/tick every 15min,
 * so this endpoint is only used for manual demo refreshes when a
 * judge wants instant feedback.
 *
 * We deliberately do NOT auto-execute trades from this path — the
 * /api/cron/tick path keeps that behind CRON_SECRET so anonymous
 * visitors can't trigger paper-portfolio mutations beyond
 * reconciliation of already-open positions.
 */

import { NextResponse } from "next/server";
import { runNewsIngest, runSectorsSnapshotWithAudit } from "@/lib/ingest";
import {
  runSignalGen,
  reconcileOpenPositions,
} from "@/lib/trading";
import { Signals, Cron } from "@/lib/db";
import { runResolutionJob } from "@/lib/outcomes/resolve-job";
import { checkPublicCronBudget } from "@/lib/public-cron-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MIN_INTERVAL_S = Number(
  process.env.PUBLIC_TICK_MIN_INTERVAL_S ?? 2 * 60,
);
const SIGNAL_EXPIRE_HOURS = 6;

async function handle(): Promise<NextResponse> {
  const verdict = await checkPublicCronBudget("public_tick", MIN_INTERVAL_S);
  if (!verdict.ok) {
    return NextResponse.json(
      { ok: false, error: verdict.reason, retry_after_s: verdict.retry_after_s },
      { status: 429 },
    );
  }

  try {
    const { data } = await Cron.recordRun("public_tick", async () => {
      const t0 = Date.now();
      const summary: Record<string, unknown> = {};

      // 1) Ingest fresh news
      try {
        const ing = await runNewsIngest({
          windowMs: 30 * 60 * 1000,
          maxItems: 80,
        });
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

      // 2) Signal gen
      try {
        const gen = await runSignalGen({ lookbackHours: 6 });
        summary.signal_gen = {
          created: gen.signals_created,
          by_tier: gen.by_tier,
        };
      } catch (err) {
        summary.signal_gen = { error: (err as Error).message };
      }

      // 3) Reconcile open positions
      try {
        summary.reconcile = await reconcileOpenPositions();
      } catch (err) {
        summary.reconcile = { error: (err as Error).message };
      }

      // 4) Expire stale pending signals
      try {
        const expiredBySignal = await Signals.expirePendingOlderThan(
          SIGNAL_EXPIRE_HOURS * 60 * 60 * 1000,
        );
        summary.expired = { by_signal_age: expiredBySignal };
      } catch (err) {
        summary.expired = { error: (err as Error).message };
      }

      // 5) Sector snapshot
      try {
        summary.sectors_snapshot = await runSectorsSnapshotWithAudit();
      } catch (err) {
        summary.sectors_snapshot = { error: (err as Error).message };
      }

      // 6) Resolve outcomes for filled positions
      try {
        summary.outcome_resolution = await runResolutionJob();
      } catch (err) {
        summary.outcome_resolution = { error: (err as Error).message };
      }

      return {
        summary: `tick: +${(summary.ingest as { new_events?: number })?.new_events ?? 0} news · ` +
          `${(summary.signal_gen as { created?: number })?.created ?? 0} signals`,
        data: { ...summary, latency_ms: Date.now() - t0 },
      };
    });
    return NextResponse.json({ ok: true, summary: data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "tick failed" },
      { status: 500 },
    );
  }
}

export async function POST() {
  return handle();
}
export async function GET() {
  return handle();
}
