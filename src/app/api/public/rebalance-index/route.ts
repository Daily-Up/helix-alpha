/**
 * POST /api/public/rebalance-index
 *
 * PUBLIC, UNAUTHENTICATED endpoint for the "▶ Rebalance Now" button on
 * /index-fund. Mirrors /api/cron/rebalance-index but applies a
 * rate-limit guard (default: max 1 rebalance per 5 min) instead of a
 * shared-secret check.
 *
 * `triggered_by` is hard-coded to `manual` so demo runs are clearly
 * labelled in the rebalance history. `preview` is honored from the
 * query string so the UI can still ask for a no-op preview.
 */

import { NextResponse } from "next/server";
import { Cron } from "@/lib/db";
import { rebalanceIndex } from "@/lib/index-fund";
import { checkPublicCronBudget } from "@/lib/public-cron-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MIN_INTERVAL_S = Number(
  process.env.PUBLIC_REBALANCE_MIN_INTERVAL_S ?? 5 * 60,
);

async function handle(req: Request): Promise<NextResponse> {
  const verdict = await checkPublicCronBudget(
    "compute_patterns",
    MIN_INTERVAL_S,
  );
  if (!verdict.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: verdict.reason,
        retry_after_s: verdict.retry_after_s,
      },
      { status: 429 },
    );
  }

  const url = new URL(req.url);
  const indexId = url.searchParams.get("index") ?? "alphacore";
  const preview = url.searchParams.get("preview") === "1";

  try {
    const result = await Cron.recordRun(
      "compute_patterns" as never,
      async () => {
        const r = await rebalanceIndex(indexId, {
          triggered_by: "manual",
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

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
