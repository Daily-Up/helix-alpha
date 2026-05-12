/**
 * GET/POST /api/cron/ingest-macro
 *
 * Pulls /macro/events (calendar) and /macro/events/{event}/history
 * (per-indicator readings). Idempotent on (event, date). Recommended
 * schedule: daily — macro prints don't change post-release and the
 * API only returns the most recent 50 readings per indicator.
 *
 * Each unique calendar event adds one /history call. With ~10-20
 * unique indicators the run completes in ~6-12s including 600ms
 * per-call throttle.
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { runMacroIngestWithAudit } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request): Promise<NextResponse> {
  try {
    assertCronAuth(req);
  } catch (err) {
    return cronAuthErrorResponse(err);
  }

  const url = new URL(req.url);
  const skipCalendar = url.searchParams.get("skipCalendar") === "1";
  const onlyEvents = url.searchParams.get("events");
  const delayMs = url.searchParams.get("delayMs");

  try {
    const summary = await runMacroIngestWithAudit({
      skipCalendar,
      onlyEvents: onlyEvents ? onlyEvents.split(",") : undefined,
      delayMs: delayMs ? Number(delayMs) : undefined,
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: (err as Error).message ?? "macro ingest failed",
      },
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
