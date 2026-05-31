/**
 * POST /api/agent/research?event_id=...
 *
 * Manually invoke the research agent on a specific news event. Returns
 * the trace id + structured classification (or error). The trace itself
 * is persisted to `agent_traces` and viewable on the audit page.
 *
 * Auth: requires CRON_SECRET (since it costs money and writes data).
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { Assets, Events } from "@/lib/db";
import { runResearchAgent } from "@/lib/ai/agents/research";

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
  const eventId = url.searchParams.get("event_id");
  if (!eventId) {
    return NextResponse.json(
      { ok: false, error: "missing event_id" },
      { status: 400 },
    );
  }

  const event = await Events.getEventById(eventId);
  if (!event) {
    return NextResponse.json(
      { ok: false, error: `event ${eventId} not found` },
      { status: 404 },
    );
  }

  // Build a compact universe view — id + symbol + name + kind is enough
  // for the system prompt to enumerate available asset ids.
  const allAssets = await Assets.getAllAssets();
  const universe = allAssets.map((a) => ({
    id: a.id,
    symbol: a.symbol,
    name: a.name,
    kind: a.kind,
  }));

  const result = await runResearchAgent({ event, universe });
  return NextResponse.json({
    ok: !result.error,
    trace_id: result.trace_id,
    rounds: result.rounds,
    tokens: result.tokens,
    cost_usd: result.cost_usd,
    classification: result.classification,
    error: result.error,
  });
}

export async function POST(req: Request) {
  return handle(req);
}
// GET allowed for easy curl testing.
export async function GET(req: Request) {
  return handle(req);
}
