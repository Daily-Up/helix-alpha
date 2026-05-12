/**
 * POST /api/trading/reset-thresholds
 *
 * Admin: reset the conviction thresholds to the calibrated defaults
 * (0.75 / 0.50 / 0.30). Useful when the math has been re-tuned and the
 * stored values are stale.
 */

import { NextResponse } from "next/server";
import { Settings } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  Settings.setSettings({
    auto_trade_min_confidence: 0.75,
    review_min_confidence: 0.5,
    info_min_confidence: 0.3,
  });
  return NextResponse.json({ ok: true, settings: Settings.getSettings() });
}

export async function GET() {
  return POST();
}
