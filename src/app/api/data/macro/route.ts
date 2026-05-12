/**
 * GET /api/data/macro
 *
 * Returns the macro surface used by /macro:
 *   - upcoming calendar (next 30 days)
 *   - recent prints (last 60 days, newest first)
 *   - top surprises (largest |actual - forecast| in window)
 */

import { NextResponse } from "next/server";
import { Macro } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const days = Math.min(
    365,
    Math.max(1, Number(url.searchParams.get("days") ?? 60)),
  );

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = Macro.getUpcomingMacroEvents(today, 30);
  const recent = Macro.listRecentHistory({ daysBack: days, limit: 80 });
  const surprises = Macro.listRecentSurprises({
    daysBack: days,
    limit: 8,
    requireForecast: true,
  });

  return NextResponse.json({
    upcoming,
    recent,
    surprises,
  });
}
