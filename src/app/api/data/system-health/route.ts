/**
 * GET /api/data/system-health
 *
 * Returns the system-health snapshot + open alerts in one call so the UI
 * has everything in a single round-trip.
 */

import { NextResponse } from "next/server";
import { Alerts } from "@/lib/db";
import { buildSystemHealth } from "@/lib/system-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = buildSystemHealth();
  const open_alerts = Alerts.listOpenAlerts();
  const recent_alerts = Alerts.listRecentAlerts(20);
  return NextResponse.json({ snapshot, open_alerts, recent_alerts });
}
