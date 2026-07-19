/**
 * GET/POST /api/cron/ingest-unlocks
 *
 * Daily: pull upcoming token-unlock schedules from DefiLlama (keyless) and
 * upsert into token_unlocks. This just keeps the /unlocks calendar fresh —
 * the trade plan (which unlocks are shortable, entry/cover timing) is
 * computed at read time from the row, and shorts execute directly from the
 * /unlocks page (NOT via the Live Signals feed). Recommended schedule: daily.
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { runUnlocksIngestWithAudit } from "@/lib/ingest";

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
  const onlyTickers = url.searchParams.get("tickers");
  const horizonDays = url.searchParams.get("horizonDays");

  try {
    const ingest = await runUnlocksIngestWithAudit({
      onlyTickers: onlyTickers ? onlyTickers.split(",") : undefined,
      horizonDays: horizonDays ? Number(horizonDays) : undefined,
    });
    return NextResponse.json({ ok: true, ingest });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "unlocks ingest failed" },
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
