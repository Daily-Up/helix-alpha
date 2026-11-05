/**
 * GET/POST /api/cron/snapshot-sector-indices
 *
 * Refreshes the Sector Rotation index-momentum cache (kv_cache['sector_indices']).
 * This is the slow part of /api/data/sectors (~16 rate-limited SoSoValue calls),
 * so it runs here with a long budget instead of on the request path.
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { Cron } from "@/lib/db";
import {
  fetchSectorIndices,
  storeSectorIndices,
} from "@/lib/sectors/index-momentum";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function handle(req: Request): Promise<NextResponse> {
  try {
    assertCronAuth(req);
  } catch (err) {
    return cronAuthErrorResponse(err);
  }
  try {
    const result = await Cron.recordRun("snapshot_sector_indices", async () => {
      const indices = await fetchSectorIndices();
      await storeSectorIndices(indices);
      const withData = indices.filter((i) => i.price != null).length;
      return {
        summary: `cached ${indices.length} indices (${withData} with data)`,
        data: { count: indices.length, withData },
      };
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "snapshot failed" },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
