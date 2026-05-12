/**
 * GET  /api/trading/settings — current snapshot
 * POST /api/trading/settings — patch one or more keys
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { Settings } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Patch = z
  .object({
    auto_trade_enabled: z.boolean().optional(),
    auto_trade_min_confidence: z.number().min(0).max(1).optional(),
    review_min_confidence: z.number().min(0).max(1).optional(),
    info_min_confidence: z.number().min(0).max(1).optional(),
    default_position_size_usd: z.number().positive().optional(),
    max_concurrent_positions: z.number().int().positive().optional(),
    max_daily_trades: z.number().int().positive().optional(),
    default_stop_loss_pct: z.number().positive().optional(),
    default_take_profit_pct: z.number().positive().optional(),
    paper_starting_balance_usd: z.number().positive().optional(),
  })
  .strict();

export async function GET() {
  return NextResponse.json(Settings.getSettings());
}

export async function POST(req: Request) {
  let patch;
  try {
    patch = Patch.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `invalid body: ${(err as Error).message}` },
      { status: 400 },
    );
  }
  Settings.setSettings(patch);
  return NextResponse.json({ ok: true, settings: Settings.getSettings() });
}
