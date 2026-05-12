/**
 * GET/POST /api/cron/ingest-etf
 *
 * Pulls aggregate flows for every (symbol, country) pair in the universe
 * plus per-fund history for every etf_fund asset.
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { runETFIngestWithAudit } from "@/lib/ingest";

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
  const limit = url.searchParams.get("limit");

  try {
    const summary = await runETFIngestWithAudit({
      limit: limit ? Number(limit) : undefined,
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "etf ingest failed" },
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
