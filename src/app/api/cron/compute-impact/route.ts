/**
 * GET/POST /api/cron/compute-impact
 *
 * Scans for classified events that don't yet have impact_metrics rows
 * and computes T+1d/3d/7d price impact for each affected asset.
 * Idempotent — running twice does no extra work for already-computed pairs.
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { runImpactComputeWithAudit } from "@/lib/analysis";

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
    const summary = await runImpactComputeWithAudit({
      limit: limit ? Number(limit) : undefined,
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "impact compute failed" },
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
