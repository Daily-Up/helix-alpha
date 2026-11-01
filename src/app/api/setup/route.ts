/**
 * POST /api/setup  { assetId: string }
 *
 * On-demand trade setup for one asset — Helix's /setup. Pulls the asset's
 * recent SoSoValue news + price and returns a Claude-generated, grounded
 * setup (bias, conviction, reasoning, levels, entry/target/stop) plus the
 * source headlines. User-triggered, so POST (not prefetchable).
 */

import { NextResponse } from "next/server";
import { generateSetup } from "@/lib/ai/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  let assetId: string | undefined;
  try {
    const body = (await req.json()) as { assetId?: string };
    assetId = body.assetId;
  } catch {
    // fall through to the validation error below
  }
  if (!assetId || typeof assetId !== "string") {
    return NextResponse.json(
      { ok: false, error: "assetId is required" },
      { status: 400 },
    );
  }

  try {
    const result = await generateSetup(assetId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "setup failed" },
      { status: 500 },
    );
  }
}
