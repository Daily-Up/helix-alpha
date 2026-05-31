/**
 * POST /api/public/generate-signals
 *
 * PUBLIC, UNAUTHENTICATED endpoint for the "Generate Signals Now"
 * button on /signals. Mirrors /api/cron/generate-signals (just the
 * gen + reconcile steps — does NOT auto-execute trades) with a 5-min
 * rate limit.
 */

import { NextResponse } from "next/server";
import {
  runSignalGenWithAudit,
  reconcileOpenPositions,
} from "@/lib/trading";
import { Cron } from "@/lib/db";
import { checkPublicCronBudget } from "@/lib/public-cron-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MIN_INTERVAL_S = Number(
  process.env.PUBLIC_GENERATE_SIGNALS_MIN_INTERVAL_S ?? 5 * 60,
);

async function handle(): Promise<NextResponse> {
  const verdict = await checkPublicCronBudget(
    "public_generate_signals",
    MIN_INTERVAL_S,
  );
  if (!verdict.ok) {
    return NextResponse.json(
      { ok: false, error: verdict.reason, retry_after_s: verdict.retry_after_s },
      { status: 429 },
    );
  }
  try {
    const { data } = await Cron.recordRun("public_generate_signals", async () => {
      const gen = await runSignalGenWithAudit({ lookbackHours: 72 });
      const reconcile = await reconcileOpenPositions();
      return {
        summary: `generated ${gen.signals_created} signals · closed ${reconcile.closed}/${reconcile.checked} positions`,
        data: { generated: gen, reconcile },
      };
    });
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "signal gen failed" },
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
