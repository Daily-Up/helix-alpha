/**
 * GET/POST /api/cron/ingest-unlocks
 *
 * Daily: pull upcoming token-unlock schedules from DefiLlama (keyless),
 * upsert into token_unlocks, then generate SHORT signals for near-term,
 * perp-tradable unlocks. One route keeps the calendar and its signals in
 * sync from a single fire. Recommended schedule: daily.
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { runUnlocksIngestWithAudit } from "@/lib/ingest";
import { generateUnlockSignalsWithAudit } from "@/lib/trading/unlock-signals";

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
  const leadHours = url.searchParams.get("leadHours");

  try {
    const ingest = await runUnlocksIngestWithAudit({
      onlyTickers: onlyTickers ? onlyTickers.split(",") : undefined,
      horizonDays: horizonDays ? Number(horizonDays) : undefined,
    });
    const signals = await generateUnlockSignalsWithAudit({
      leadHours: leadHours ? Number(leadHours) : undefined,
    });
    return NextResponse.json({ ok: true, ingest, signals });
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
