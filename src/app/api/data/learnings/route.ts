/**
 * GET /api/data/learnings?window=30d
 *
 * Returns calibration data for the /learnings page:
 *   - overall hit rates and PnL
 *   - breakdown by confidence bucket
 *   - breakdown by event type
 *   - breakdown by tier
 *   - breakdown by asset kind
 *   - recent signal outcomes (table)
 *
 * `window` controls the lookback for `since_ms`:
 *   "7d" | "30d" | "90d" | "all" (default 30d)
 */

import { NextResponse } from "next/server";
import { Postmortem } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseWindow(w: string | null): number | undefined {
  switch (w) {
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "90d":
      return 90 * 24 * 60 * 60 * 1000;
    case "all":
      return undefined;
    case "30d":
    case null:
    default:
      return 30 * 24 * 60 * 60 * 1000;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const since_ms = parseWindow(url.searchParams.get("window"));
  const filter = since_ms != null ? { since_ms } : {};

  const overall = Postmortem.overallStats(filter);
  const byConfidence = Postmortem.statsByConfidence(filter);
  const byEventType = Postmortem.statsByEventType(filter);
  const byTier = Postmortem.statsByTier(filter);
  const byAssetKind = Postmortem.statsByAssetKind(filter);
  const recent = Postmortem.recentSignalOutcomes(150, filter);

  return NextResponse.json({
    window: url.searchParams.get("window") ?? "30d",
    overall,
    by_confidence: byConfidence,
    by_event_type: byEventType,
    by_tier: byTier,
    by_asset_kind: byAssetKind,
    recent,
  });
}
