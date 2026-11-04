/**
 * GET /api/wealth/catalog
 *
 * The live SoDEX Wealth catalog (funds + market quotes merged), grouped into
 * Stable Earn / Curated ETF / Specialty. Proxied server-side so the browser
 * avoids CORS and we can cache. Read-only.
 */

import { NextResponse } from "next/server";
import { fetchCatalog } from "@/lib/wealth/client";
import { groupByCategory } from "@/lib/wealth/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const funds = await fetchCatalog();
    return NextResponse.json({
      ok: true,
      asOf: new Date().toISOString(),
      funds,
      groups: groupByCategory(funds),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message || "catalog fetch failed" },
      { status: 502 },
    );
  }
}
