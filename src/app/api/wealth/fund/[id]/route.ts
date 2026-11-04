/**
 * GET /api/wealth/fund/{id}?address=0x...
 *
 * Everything the per-fund page needs: the fund's live catalog row + page
 * metadata, the connected wallet's holding in it, SoDEX per-fund news, and the
 * Helix classified events mapped to its underlying (same strict asset mapping
 * as the suggestion cards). Read-only.
 */

import { NextResponse } from "next/server";
import {
  fetchCatalog,
  fetchFundNews,
  fetchPortfolio,
  type WealthNewsItem,
} from "@/lib/wealth/client";
import { fundPageMeta } from "@/lib/wealth/catalog";
import { matchedFundEvents, type FundEvent } from "@/lib/wealth/suggestions";
import type { WealthPosition } from "@/lib/wealth/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const address = new URL(req.url).searchParams.get("address") ?? "";
  const hasAddr = ADDR_RE.test(address);

  try {
    const catalog = await fetchCatalog();
    const fund = catalog.find((f) => f.fundId === id);
    if (!fund) {
      return NextResponse.json({ ok: false, error: "fund not found" }, { status: 404 });
    }
    const meta = fundPageMeta(fund.fundId, fund.category);

    const [news, events, holding] = await Promise.all([
      fund.newsSeo
        ? fetchFundNews(fund.newsSeo, 30).catch(() => [] as WealthNewsItem[])
        : Promise.resolve([] as WealthNewsItem[]),
      matchedFundEvents(fund.fundId).catch(() => [] as FundEvent[]),
      hasAddr
        ? fetchPortfolio(address)
            .then((p) => p.positions.find((x) => x.fundId === fund.fundId) ?? null)
            .catch(() => null as WealthPosition | null)
        : Promise.resolve(null as WealthPosition | null),
    ]);

    return NextResponse.json({
      ok: true,
      fund,
      meta,
      holding,
      news,
      events,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message || "fund fetch failed" },
      { status: 502 },
    );
  }
}
