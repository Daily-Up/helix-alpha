/**
 * POST /api/public/regenerate-briefing
 *
 * PUBLIC, UNAUTHENTICATED endpoint for the "↻ Regenerate" button on
 * /briefing. Mirrors /api/cron/generate-briefing but applies a
 * rate-limit guard (default: max 1 regenerate per 5 min) instead of a
 * shared-secret check.
 *
 * NEVER accepts ?force=1 from the public — only the cron endpoint can
 * bypass the per-day idempotency. So the button can only "regenerate"
 * if there is no briefing for today's UTC date yet, OR after the
 * rate-limit window expires.
 *
 * To still allow re-rolling today's briefing from the UI, we DO pass
 * force=true to runBriefing. The rate limit is the only thing
 * preventing abuse.
 */

import { NextResponse } from "next/server";
import { runBriefing } from "@/lib/ai";
import { Cron } from "@/lib/db";
import { checkPublicCronBudget } from "@/lib/public-cron-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MIN_INTERVAL_S = Number(
  process.env.PUBLIC_BRIEFING_MIN_INTERVAL_S ?? 5 * 60,
);

async function handle(): Promise<NextResponse> {
  const verdict = await checkPublicCronBudget(
    "generate_briefing",
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

  try {
    const result = await Cron.recordRun("generate_briefing", async () => {
      const r = await runBriefing({ force: true });
      const text = r.cached
        ? `cached date=${r.date}`
        : `generated date=${r.date} cost=$${r.cost_usd.toFixed(4)} ` +
          `tokens(in/out/cached)=${r.tokens.input}/${r.tokens.output}/${r.tokens.cached}`;
      return { summary: text, data: r };
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: (err as Error).message ?? "briefing generation failed",
      },
      { status: 500 },
    );
  }
}

export async function POST() {
  return handle();
}
export async function GET() {
  return handle();
}
