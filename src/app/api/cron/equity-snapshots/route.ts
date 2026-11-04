/**
 * GET/POST /api/cron/equity-snapshots
 *
 * Daily backstop for the portfolio equity curve. The primary snapshot path is
 * on page visit (POST /api/portfolio/equity-snapshot, throttled to 15 min),
 * but a user who doesn't open the page that day would leave a gap — so once a
 * day we re-snapshot every recently-active address (one with a snapshot in the
 * last 30 days) directly.
 *
 * Daily cadence only: Vercel Hobby allows daily crons, not the 15-min one the
 * on-visit throttle approximates. Read-only against SoDEX; writes our own rows.
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { EquitySnapshots } from "@/lib/db";
import { computeSnapshotEquity } from "@/lib/portfolio/fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DAY = 24 * 60 * 60 * 1000;
/** Cap the fan-out so one slow run can't blow the function budget. */
const MAX_ADDRESSES = 50;

async function handle(req: Request): Promise<NextResponse> {
  try {
    assertCronAuth(req);
  } catch (err) {
    return cronAuthErrorResponse(err);
  }

  const now = Date.now();
  try {
    const addresses = (
      await EquitySnapshots.activeAddresses(now - 30 * DAY)
    ).slice(0, MAX_ADDRESSES);

    let written = 0;
    const errors: string[] = [];
    for (const address of addresses) {
      try {
        // Strict: any failing source throws → this address is skipped (not
        // recorded as a partial), rather than carving a dip into its curve.
        const c = await computeSnapshotEquity(address);
        await EquitySnapshots.insert({
          address,
          ts: now,
          perps_equity: c.perps_equity,
          spot_equity: c.spot_equity,
          total_equity: c.total_equity,
          perps_upnl: c.perps_upnl,
          spot_upnl: null,
        });
        written += 1;
      } catch (e) {
        errors.push(`${address.slice(0, 10)}…: ${(e as Error).message}`);
      }
    }

    return NextResponse.json({
      ok: true,
      addresses: addresses.length,
      written,
      errors,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "cron failed" },
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
