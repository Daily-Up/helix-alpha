/**
 * POST /api/agent/debate?signal_id=...
 *
 * Run the 3-agent debate (bull → bear → synthesizer) on a signal. The
 * debate writes three rows to agent_traces: debate-bull, debate-bear,
 * and debate-synth. The audit page surfaces all three under the signal.
 *
 * Auth: CRON_SECRET (expensive — ~$0.10/run).
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { Assets, Events, Signals } from "@/lib/db";
import { runDebateAgent } from "@/lib/ai/agents/debate";

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
  const signalId = url.searchParams.get("signal_id");
  if (!signalId) {
    return NextResponse.json(
      { ok: false, error: "missing signal_id" },
      { status: 400 },
    );
  }

  const signal = await Signals.getSignal(signalId);
  if (!signal) {
    return NextResponse.json(
      { ok: false, error: `signal ${signalId} not found` },
      { status: 404 },
    );
  }
  const asset = await Assets.getAssetById(signal.asset_id);
  const event = signal.triggered_by_event_id
    ? await Events.getEventById(signal.triggered_by_event_id)
    : undefined;

  const result = await runDebateAgent({
    signal,
    asset_symbol: asset?.symbol ?? signal.asset_id,
    catalyst_iso: event
      ? new Date(event.release_time).toISOString()
      : new Date(signal.fired_at).toISOString(),
    catalyst_title: event?.title ?? "(no event title)",
    catalyst_author: event?.author ?? null,
  });

  return NextResponse.json({
    ok: !result.error,
    bull_trace_id: result.bull_trace_id,
    bear_trace_id: result.bear_trace_id,
    synthesizer_trace_id: result.synthesizer_trace_id,
    bull_argument: result.bull_argument,
    bear_argument: result.bear_argument,
    synthesis: result.synthesis,
    rounds: result.total_rounds,
    tokens: result.total_tokens,
    cost_usd: result.total_cost_usd,
    error: result.error,
  });
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
