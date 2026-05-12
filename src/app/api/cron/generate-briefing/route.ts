/**
 * GET/POST /api/cron/generate-briefing
 *
 * Generates today's Daily AI Briefing — a 3-paragraph market read with
 * a top trade idea, synthesized by Claude across pending signals,
 * recent classifications, sector rotation, ETF flows, AlphaIndex
 * positions, and macro calendar.
 *
 * Idempotent on the UTC date: re-running the same day returns the
 * existing briefing unless ?force=1.
 *
 * Recommended schedule: once per day at 13:00 UTC.
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { runBriefing } from "@/lib/ai";
import { Cron } from "@/lib/db";

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
  const force = url.searchParams.get("force") === "1";
  const dateOverride = url.searchParams.get("date") ?? undefined;

  try {
    const result = await Cron.recordRun("generate_briefing", async () => {
      const r = await runBriefing({ date: dateOverride, force });
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

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
