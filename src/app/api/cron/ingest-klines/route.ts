/**
 * GET/POST /api/cron/ingest-klines
 *
 * Pulls daily klines for every token + RWA in the universe.
 * Idempotent — safe to call hourly.
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { runKlinesIngestWithAudit } from "@/lib/ingest";

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
  const days = url.searchParams.get("days");
  const opts = {
    daysBack: days ? Number(days) : undefined,
  };

  try {
    const summary = await runKlinesIngestWithAudit(opts);
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "klines ingest failed" },
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
