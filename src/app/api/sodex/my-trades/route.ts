/**
 * GET /api/sodex/my-trades?wallet=0x…
 *
 * Returns the audit-log history of live SoDEX trades for the given
 * wallet. Used by the connect page + future per-wallet trade
 * sidebar. Public — anyone with the address can read.
 */

import { NextResponse } from "next/server";
import { ExecutedTrades } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet");
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return NextResponse.json(
      { ok: false, error: "wallet must be a 0x… address" },
      { status: 400 },
    );
  }
  const limit = Math.min(
    200,
    Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50),
  );
  const trades = await ExecutedTrades.listTradesForWallet(wallet, limit);
  return NextResponse.json({ ok: true, trades });
}
