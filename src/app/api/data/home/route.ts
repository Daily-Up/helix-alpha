/**
 * GET /api/data/home
 *
 * Serves the dashboard payload from kv_cache with stale-while-revalidate: a
 * fresh cache (<HOME_FRESH_MS) serves instantly; an older cache still serves
 * instantly and refreshes in the background; only a cold, empty cache blocks on
 * a compute. The 5-min `tick` pre-warms the cache (refreshHomeSnapshot), so in
 * practice this is always an instant cache read. Compute logic + caching live
 * in @/lib/home/snapshot.
 */

import { after, NextResponse } from "next/server";
import {
  HOME_FRESH_MS,
  computeHomeSnapshot,
  readHomeSnapshot,
  storeHomeSnapshot,
} from "@/lib/home/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const cached = await readHomeSnapshot();
  if (cached) {
    // Not fresh → refresh in the background, but serve the cached copy now so
    // the dashboard never waits on the recompute.
    if (Date.now() - cached.as_of >= HOME_FRESH_MS) {
      after(async () => {
        try {
          await storeHomeSnapshot(await computeHomeSnapshot());
        } catch {
          /* keep last good */
        }
      });
    }
    return NextResponse.json(cached.payload);
  }

  // Cold / empty cache: compute now, serve, and persist for everyone next.
  const payload = await computeHomeSnapshot();
  after(async () => {
    try {
      await storeHomeSnapshot(payload);
    } catch {
      /* best effort */
    }
  });
  return NextResponse.json(payload);
}
