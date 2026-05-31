/**
 * POST /api/agent/verification?signal_id=...
 *
 * Manually invoke the verification agent on a specific pending signal.
 * Returns the trace id + verdict. The trace is persisted to
 * `agent_traces` (visible on the audit page).
 *
 * Auth: CRON_SECRET (costs money, mutates trace state).
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { Assets, Events, Signals } from "@/lib/db";
import { runVerificationAgent } from "@/lib/ai/agents/verification";

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

  const result = await runVerificationAgent({
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
    trace_id: result.trace_id,
    rounds: result.rounds,
    tokens: result.tokens,
    cost_usd: result.cost_usd,
    verdict: result.verdict,
    error: result.error,
  });
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
