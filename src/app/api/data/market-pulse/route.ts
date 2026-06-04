/**
 * GET /api/data/market-pulse — current BTC/ETH/SOL regime snapshot.
 *
 * Same data the agents inject into their system prompts. Used by the
 * Market Pulse ribbon in the UI so users see exactly what the agent
 * sees.
 *
 * Cache-Control: 30s — refresh that often even on bursty UI use; the
 * regime changes slowly and the underlying classifier query is ~50ms.
 */
import { NextResponse } from "next/server";
import { getMarketPulse, formatPulseForPrompt } from "@/lib/regime/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const pulse = await getMarketPulse();
    return NextResponse.json(
      {
        ok: true,
        computed_at: pulse.computed_at,
        rows: pulse.rows,
        prompt_view: formatPulseForPrompt(pulse),
      },
      {
        headers: { "Cache-Control": "public, max-age=30, s-maxage=30" },
      },
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
