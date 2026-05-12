/**
 * POST /api/trading/execute
 *
 * Manually execute a pending signal. Body:
 *   { signal_id: string, size_usd?: number, stop_pct?: number, target_pct?: number }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { executeSignal } from "@/lib/trading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  signal_id: z.string().min(1),
  size_usd: z.number().positive().optional(),
  stop_pct: z.number().positive().optional(),
  target_pct: z.number().positive().optional(),
});

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

  const result = await executeSignal(parsed.signal_id, {
    size_usd: parsed.size_usd,
    stop_pct: parsed.stop_pct,
    target_pct: parsed.target_pct,
    source: "manual",
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
