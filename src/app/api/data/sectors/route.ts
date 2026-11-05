/**
 * GET /api/data/sectors
 *
 * Combines two views:
 *   • Sector dominance — latest cached /currencies/sector-spotlight snapshot
 *     ("where is capital sitting RIGHT NOW"). Fast DB read.
 *   • SSI index momentum — "where is capital ROTATING" (1d/7d/1m). This needs
 *     ~16 rate-limited SoSoValue calls, so it is NOT fetched on the request
 *     path (that caused 504s / endless loading). It is refreshed out-of-band by
 *     /api/cron/snapshot-sector-indices and read here from kv_cache with an
 *     "as of" time.
 */

import { NextResponse } from "next/server";
import { Sectors } from "@/lib/db";
import { readSectorIndices } from "@/lib/sectors/index-momentum";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STALE_MS = 30 * 60 * 1000; // momentum older than 30 min is flagged stale

export async function GET() {
  const sectors = await Sectors.getLatestSectors();
  const cached = await readSectorIndices();

  return NextResponse.json({
    sectors,
    indices: cached?.indices ?? [],
    as_of: cached?.as_of ?? null,
    stale: cached ? Date.now() - cached.as_of > STALE_MS : false,
    // No cached momentum yet (first load after deploy) — the cron fills it
    // within a few minutes; dominance is already available.
    pending: !cached,
  });
}
