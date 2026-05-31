/**
 * POST /api/trading/purge-pending — admin endpoint. Wave 2: async.
 */

import { NextResponse } from "next/server";
import { run } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const result = await run(
    "DELETE FROM signals WHERE status = 'pending'",
  );
  return NextResponse.json({ ok: true, deleted: Number(result.rowsAffected) });
}
