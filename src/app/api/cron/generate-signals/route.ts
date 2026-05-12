/**
 * GET/POST /api/cron/generate-signals
 *
 * Pipeline:
 *   1. Generate new tiered signals from recent classifications
 *   2. Auto-execute pending Tier-1 signals if auto-trade is enabled
 *   3. Reconcile open positions against live SoDEX prices
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import {
  runSignalGenWithAudit,
  autoExecutePending,
  reconcileOpenPositions,
} from "@/lib/trading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request): Promise<NextResponse> {
  try {
    assertCronAuth(req);
  } catch (err) {
    return cronAuthErrorResponse(err);
  }

  try {
    const gen = await runSignalGenWithAudit({ lookbackHours: 72 });
    const auto = await autoExecutePending();
    const reconcile = await reconcileOpenPositions();
    return NextResponse.json({
      ok: true,
      generated: gen,
      auto_executed: auto.executed.length,
      auto_skipped: auto.skipped,
      auto_reason: auto.reason,
      reconcile,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "signal gen failed" },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
