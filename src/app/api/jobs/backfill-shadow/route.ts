/**
 * POST /api/jobs/backfill-shadow
 *
 * Trigger the v2 shadow backfill (Part 1 / I-39). Idempotent — safe
 * to call repeatedly. Body params (all optional):
 *   { lookback_days?: number, starting_nav?: number }
 */

import { NextResponse } from "next/server";
import { backfillShadowV2 } from "@/lib/jobs/backfill-shadow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { lookback_days?: number; starting_nav?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* allow empty body */
  }
  const lookback = clamp(body.lookback_days ?? 30, 1, 365);
  const starting = body.starting_nav ?? 10_000;
  try {
    const summary = backfillShadowV2("alphacore", lookback, starting);
    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
