/**
 * GET /api/data/sectors
 *
 * Combines two views:
 *   • Latest /currencies/sector-spotlight snapshot (cached in sector_snapshots)
 *   • Live /indices/{ticker}/market-snapshot for every SSI sector index
 *
 * The first answers "where is capital sitting RIGHT NOW" (dominance).
 * The second answers "where is capital ROTATING" (1d / 7d / 1m momentum).
 */

import { NextResponse } from "next/server";
import { Indices } from "@/lib/sosovalue";
import { Sectors, Assets } from "@/lib/db";
import type { IndexMarketSnapshot } from "@/lib/sosovalue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface IndexRow {
  ticker: string;
  name: string;
  price: number | null;
  change_pct_24h: number | null;
  roi_7d: number | null;
  roi_1m: number | null;
  roi_3m: number | null;
  roi_1y: number | null;
  ytd: number | null;
}

export async function GET() {
  // ── Sector dominance from cached snapshot ─────────────────────
  const sectors = Sectors.getLatestSectors();

  // ── SSI index momentum (live) ─────────────────────────────────
  const indexAssets = Assets.getAssetsByKind("index");
  const indices: IndexRow[] = [];

  // Sequential to respect rate limits.
  for (const a of indexAssets) {
    if (a.sosovalue.kind !== "index") continue;
    const ticker = a.sosovalue.ticker;
    try {
      const snap: IndexMarketSnapshot = await Indices.getIndexMarketSnapshot(
        ticker,
      );
      indices.push({
        ticker,
        name: a.name,
        price: snap.price ?? null,
        change_pct_24h: snap.change_pct_24h ?? null,
        roi_7d: snap.roi_7d ?? null,
        roi_1m: snap.roi_1m ?? null,
        roi_3m: snap.roi_3m ?? null,
        roi_1y: snap.roi_1y ?? null,
        ytd: snap.ytd ?? null,
      });
    } catch {
      indices.push({
        ticker,
        name: a.name,
        price: null,
        change_pct_24h: null,
        roi_7d: null,
        roi_1m: null,
        roi_3m: null,
        roi_1y: null,
        ytd: null,
      });
    }
    // Brief pause between calls
    await new Promise((r) => setTimeout(r, 250));
  }

  return NextResponse.json({ sectors, indices });
}
