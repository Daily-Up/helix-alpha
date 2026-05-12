/**
 * POST /api/trading/dismiss
 * Body: { signal_id: string }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { dismissSignal } from "@/lib/trading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ signal_id: z.string().min(1) });

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `invalid body: ${(err as Error).message}` },
      { status: 400 },
    );
  }

  const result = dismissSignal(parsed.signal_id);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
