/**
 * GET/POST /api/cron/ingest-btc-treasuries
 *
 * Pulls /btc-treasuries (companies) + /purchase-history (per-ticker
 * BTC accumulation events). Idempotent on (ticker, date). Recommended
 * schedule: daily.
 *
 * Each company adds one /purchase-history call (~56 calls per run).
 * With the default 600ms throttle that's ~35s end-to-end and stays
 * well under the 20 req/min rate limit.
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { runTreasuriesIngestWithAudit } from "@/lib/ingest";

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
  const delayMs = url.searchParams.get("delayMs");

  try {
    const summary = await runTreasuriesIngestWithAudit({
      onlyTickers: onlyTickers ? onlyTickers.split(",") : undefined,
      delayMs: delayMs ? Number(delayMs) : undefined,
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: (err as Error).message ?? "treasuries ingest failed",
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
