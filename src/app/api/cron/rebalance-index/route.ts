/**
 * GET/POST /api/cron/rebalance-index
 *
 * Triggers an AlphaIndex rebalance.
 *
 * Query params:
 *   ?index=alphacore       which index to rebalance (default alphacore)
 *   ?triggered_by=manual   tag for the audit log (default scheduled)
 *   ?preview=1             compute weights but don't actually trade
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { Cron } from "@/lib/db";
import { rebalanceIndex } from "@/lib/index-fund";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request): Promise<NextResponse> {
  try {
    assertCronAuth(req);
  } catch (err) {
    return cronAuthErrorResponse(err);
  }

  const url = new URL(req.url);
  const indexId = url.searchParams.get("index") ?? "alphacore";
  const triggered_by = (url.searchParams.get("triggered_by") ??
    "scheduled") as "scheduled" | "manual" | "signal_cluster";
  const preview = url.searchParams.get("preview") === "1";

  try {
    const result = await Cron.recordRun(
      "compute_patterns" as never, // re-use a known job kind
      async () => {
        const r = await rebalanceIndex(indexId, {
          triggered_by,
          execute: !preview,
        });
        return {
          summary:
            `${preview ? "PREVIEW " : ""}rebalance: ${r.trades.length} trades, ` +
            `pre=$${r.pre_nav.toFixed(0)} → post=$${r.post_nav.toFixed(0)}, ` +
            `weights=${Object.keys(r.weights).length}`,
          data: r,
        };
      },
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "rebalance failed" },
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
