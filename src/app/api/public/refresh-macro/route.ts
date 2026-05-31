/**
 * POST /api/public/refresh-macro
 *
 * PUBLIC, UNAUTHENTICATED endpoint for the "Refresh" button on /macro.
 * Mirrors /api/cron/ingest-macro but applies a 5-min rate limit by
 * inspecting cron_runs.
 */

import { NextResponse } from "next/server";
import { runMacroIngestWithAudit } from "@/lib/ingest";
import { checkPublicCronBudget } from "@/lib/public-cron-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MIN_INTERVAL_S = Number(
  process.env.PUBLIC_REFRESH_MIN_INTERVAL_S ?? 5 * 60,
);

async function handle(): Promise<NextResponse> {
  const verdict = await checkPublicCronBudget("ingest_macro", MIN_INTERVAL_S);
  if (!verdict.ok) {
    return NextResponse.json(
      { ok: false, error: verdict.reason, retry_after_s: verdict.retry_after_s },
      { status: 429 },
    );
  }
  try {
    const summary = await runMacroIngestWithAudit({});
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "macro refresh failed" },
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
