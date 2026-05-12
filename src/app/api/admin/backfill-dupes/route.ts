/**
 * POST /api/admin/backfill-dupes
 *
 * One-time admin endpoint: runs Events.backfillDuplicates() across the
 * existing news_events table to mark already-stored duplicates. Safe
 * to run multiple times — idempotent.
 *
 * Designed to be called once after the dedup feature ships, then never
 * again. The cron-time dedup (in runNewsIngest) handles new incoming
 * events from then on.
 */

import { NextResponse } from "next/server";
import { Events } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const t0 = Date.now();
  const result = Events.backfillDuplicates();
  return NextResponse.json({
    ok: true,
    ...result,
    latency_ms: Date.now() - t0,
  });
}

// Allow GET for convenience while running locally — production deploys
// should rely on POST + cron auth.
export async function GET() {
  return POST();
}
