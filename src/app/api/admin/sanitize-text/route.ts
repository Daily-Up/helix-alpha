/**
 * POST /api/admin/sanitize-text
 *
 * One-time admin endpoint: scans the news_events table and re-runs
 * the HTML/entity sanitizer over title + content. Idempotent — fine
 * to run multiple times.
 *
 * Use after deploying the sanitization logic to clean historical
 * SoSoValue search-highlight spans baked into stored rows.
 */

import { NextResponse } from "next/server";
import { Events } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const t0 = Date.now();
  const result = Events.backfillSanitizeText();
  return NextResponse.json({
    ok: true,
    ...result,
    latency_ms: Date.now() - t0,
  });
}

export async function GET() {
  return POST();
}
