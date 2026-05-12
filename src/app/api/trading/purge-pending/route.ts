/**
 * POST /api/trading/purge-pending
 *
 * Admin: deletes ALL pending signals. Useful after tuning the conviction
 * formula so old (now-misclassified) signals don't clutter the UI.
 *
 * Does NOT touch executed/dismissed signals or any open paper trades.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const result = db()
    .prepare("DELETE FROM signals WHERE status = 'pending'")
    .run();
  return NextResponse.json({ ok: true, deleted: result.changes });
}
