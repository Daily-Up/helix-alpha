/**
 * GET /api/data/framework-switches?limit=10
 *
 * Returns the last N framework v1↔v2.1 selection events for the
 * /system-health "Framework switch history" panel (Part 3 of v2.1
 * attribution). See I-38.
 */

import { NextResponse } from "next/server";
import { FrameworkSwitches } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = clamp(numParam(url, "limit") ?? 10, 1, 100);
  const rows = FrameworkSwitches.listSwitches(limit);
  return NextResponse.json({ ok: true, rows });
}

function numParam(url: URL, key: string): number | undefined {
  const v = url.searchParams.get(key);
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
