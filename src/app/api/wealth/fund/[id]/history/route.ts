/**
 * GET /api/wealth/fund/{id}/history?interval=1d&range=1Y
 *
 * Price history (line series) for one Wealth fund, for the detail chart.
 */

import { NextResponse } from "next/server";
import { fetchPriceHistory } from "@/lib/wealth/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_INTERVAL = new Set(["1h", "4h", "1d", "1w"]);
const ALLOWED_RANGE = new Set(["1W", "1M", "3M", "6M", "1Y", "ALL"]);

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const interval = url.searchParams.get("interval") ?? "1d";
  const range = url.searchParams.get("range") ?? "1Y";
  if (!ALLOWED_INTERVAL.has(interval) || !ALLOWED_RANGE.has(range)) {
    return NextResponse.json({ ok: false, error: "bad interval/range" }, { status: 400 });
  }
  try {
    const points = await fetchPriceHistory(id, interval, range);
    return NextResponse.json({ ok: true, fundId: id, interval, range, points });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message || "history fetch failed" },
      { status: 502 },
    );
  }
}
