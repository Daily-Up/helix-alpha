/**
 * GET /api/wealth/portfolio?address=0x...
 *
 * A wallet's SoDEX Wealth holdings + PnL (read-only, proxied server-side).
 */

import { NextResponse } from "next/server";
import { fetchPortfolio } from "@/lib/wealth/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address") ?? "";
  if (!ADDR_RE.test(address)) {
    return NextResponse.json({ ok: false, error: "invalid address" }, { status: 400 });
  }
  try {
    const portfolio = await fetchPortfolio(address);
    return NextResponse.json({ ok: true, portfolio });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message || "portfolio fetch failed" },
      { status: 502 },
    );
  }
}
