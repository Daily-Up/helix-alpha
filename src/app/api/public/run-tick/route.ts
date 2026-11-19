/**
 * GET/POST /api/public/run-tick
 *
 * PUBLIC, UNAUTHENTICATED endpoint that runs the master pipeline (ingest ->
 * signals -> reconcile -> sweep -> sectors -> outcome resolution) with a 2-min
 * rate limit. Powers BOTH the "⟳ Tick now" button on /signals AND an external
 * cron pinger that keeps ingestion fresh (no browser tab required).
 *
 * Response mode:
 *   - POST (or ?wait=1): run synchronously and return the summary — the
 *     /signals button wants to show what happened.
 *   - GET  (or ?wait=0): ACK immediately ({ queued: true }) and run the pipeline
 *     in after(), so external cron services (cron-job.org, UptimeRobot, …) get an
 *     instant response instead of timing out while the ~30-60s pipeline runs.
 *     The function stays alive for the after() work up to maxDuration (60s).
 *
 * We deliberately do NOT auto-execute trades from this path — the
 * /api/cron/tick path keeps that behind CRON_SECRET so anonymous visitors
 * can't trigger trade execution.
 */

import { NextResponse, after } from "next/server";
import { runNewsIngest, runSectorsSnapshotWithAudit } from "@/lib/ingest";
import { runSignalGen, reconcileOpenPositions } from "@/lib/trading";
import { Signals, Cron } from "@/lib/db";
import { runResolutionJob } from "@/lib/outcomes/resolve-job";
import { checkPublicCronBudget } from "@/lib/public-cron-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MIN_INTERVAL_S = Number(process.env.PUBLIC_TICK_MIN_INTERVAL_S ?? 2 * 60);

/** The master pipeline. Wrapped by Cron.recordRun("public_tick", ...). */
async function runPublicPipeline() {
  const t0 = Date.now();
  const summary: Record<string, unknown> = {};

  // 1) Ingest fresh news
  try {
    const ing = await runNewsIngest({
      windowMs: 30 * 60 * 1000,
      // Trimmed 80->40 so the run fits the 60s function cap instead of
      // timing out mid-classify (which stranded a running lock).
      maxItems: 40,
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
    summary.signal_gen = { created: gen.signals_created, by_tier: gen.by_tier };
  } catch (err) {
    summary.signal_gen = { error: (err as Error).message };
  }

  // 3) Reconcile open positions
  try {
    summary.reconcile = await reconcileOpenPositions();
  } catch (err) {
    summary.reconcile = { error: (err as Error).message };
  }

  // 4) Expire pending signals whose own horizon (expires_at) has passed, or
  //    that failed corroboration. Horizon-respecting — no flat 6h clock.
  try {
    const swept = await Signals.sweepExpiredSignals();
    summary.expired = {
      stale_unexecuted: swept.stale_unexecuted,
      uncorroborated: swept.uncorroborated,
    };
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
    summary:
      `tick: +${(summary.ingest as { new_events?: number })?.new_events ?? 0} news · ` +
      `${(summary.signal_gen as { created?: number })?.created ?? 0} signals`,
    data: { ...summary, latency_ms: Date.now() - t0 },
  };
}

async function handle(req: Request): Promise<NextResponse> {
  const verdict = await checkPublicCronBudget("public_tick", MIN_INTERVAL_S);
  if (!verdict.ok) {
    return NextResponse.json(
      { ok: false, error: verdict.reason, retry_after_s: verdict.retry_after_s },
      { status: 429 },
    );
  }

  // Sync vs fire-and-forget. External cron pingers time out waiting ~30-60s
  // for the pipeline, so a GET acks immediately and runs the work in after()
  // (still within the 60s function life). POST stays synchronous so the
  // /signals "Tick now" button gets its summary. ?wait=0 / ?wait=1 overrides.
  const waitParam = new URL(req.url).searchParams.get("wait");
  const wait = waitParam != null ? waitParam !== "0" : req.method === "POST";

  if (!wait) {
    after(async () => {
      try {
        await Cron.recordRun("public_tick", runPublicPipeline);
      } catch (err) {
        console.error(
          "[run-tick] background pipeline failed:",
          (err as Error).message,
        );
      }
    });
    return NextResponse.json({ ok: true, queued: true });
  }

  try {
    const { data } = await Cron.recordRun("public_tick", runPublicPipeline);
    return NextResponse.json({ ok: true, summary: data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "tick failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
