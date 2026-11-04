/**
 * GET /api/wealth/suggestions?address=0x...
 *
 * The "special suggestions" rail: factual, input-grounded cards. The address
 * is optional — without it, portfolio/idle-USDC inputs are skipped and only
 * catalog-level cards (e.g. the Stable Earn APY gap) can appear.
 */

import { NextResponse } from "next/server";
import {
  fetchCatalog,
  fetchPortfolio,
  fetchSpotUsdc,
} from "@/lib/wealth/client";
import { buildSuggestions } from "@/lib/wealth/suggestions";
import type { WealthPortfolio } from "@/lib/wealth/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address") ?? "";
  const hasAddr = ADDR_RE.test(address);

  try {
    const [catalog, portfolio, idle] = await Promise.all([
      fetchCatalog(),
      hasAddr
        ? fetchPortfolio(address).catch(() => null as WealthPortfolio | null)
        : Promise.resolve(null as WealthPortfolio | null),
      hasAddr
        ? fetchSpotUsdc(address).catch(() => ({ usdc: null, asOf: new Date().toISOString() }))
        : Promise.resolve({ usdc: null, asOf: new Date().toISOString() }),
    ]);

    const suggestions = await buildSuggestions({
      catalog,
      portfolio,
      idleUsdc: idle.usdc,
      idleUsdcAsOf: idle.asOf,
    });

    return NextResponse.json({
      ok: true,
      asOf: new Date().toISOString(),
      connected: hasAddr,
      suggestions,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message || "suggestions failed" },
      { status: 502 },
    );
  }
}
