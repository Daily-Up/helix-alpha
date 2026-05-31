/**
 * POST /api/agent/demo
 *
 * PUBLIC, UNAUTHENTICATED endpoint used by the "Run live agent" button
 * on the audit + /agents pages. Anyone visiting the deployment can hit
 * this. The demo-budget guard makes it safe-by-default:
 *   - Rate-limited: max 1 demo run per ~30s (configurable).
 *   - Spend-capped: refused if today's agent spend ≥ $3 (configurable).
 *
 * Body (POST) or query (GET):
 *   mode: 'research' | 'verification' | 'debate'
 *   event_id?: string    // required for mode=research
 *   signal_id?: string   // required for mode=verification|debate
 *
 * Returns the same shape as the corresponding authenticated endpoint,
 * with the trace(s) persisted to agent_traces tagged with a
 * 'demo-<mode>' prefix so dashboards can distinguish.
 */

import { NextResponse } from "next/server";
import { Assets, Events, Signals } from "@/lib/db";
import { runResearchAgent } from "@/lib/ai/agents/research";
import { runVerificationAgent } from "@/lib/ai/agents/verification";
import { runDebateAgent } from "@/lib/ai/agents/debate";
import { checkDemoBudget } from "@/lib/ai/agents/demo-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  mode?: string;
  event_id?: string;
  signal_id?: string;
}

async function readBody(req: Request): Promise<Body> {
  if (req.method === "GET") {
    const url = new URL(req.url);
    return {
      mode: url.searchParams.get("mode") ?? undefined,
      event_id: url.searchParams.get("event_id") ?? undefined,
      signal_id: url.searchParams.get("signal_id") ?? undefined,
    };
  }
  try {
    return (await req.json()) as Body;
  } catch {
    return {};
  }
}

async function handle(req: Request): Promise<NextResponse> {
  // Rate-limit + spend check FIRST so we never spawn the agent if
  // the request would be refused.
  const verdict = await checkDemoBudget();
  if (!verdict.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: verdict.reason,
        spend_today_usd: verdict.spend_today_usd,
        spend_cap_usd: verdict.spend_cap_usd,
        retry_after_s: verdict.retry_after_s,
      },
      { status: 429 },
    );
  }

  const body = await readBody(req);
  const mode = body.mode ?? "research";

  if (mode === "research") {
    if (!body.event_id) {
      return NextResponse.json(
        { ok: false, error: "event_id required for mode=research" },
        { status: 400 },
      );
    }
    const event = await Events.getEventById(body.event_id);
    if (!event) {
      return NextResponse.json(
        { ok: false, error: `event ${body.event_id} not found` },
        { status: 404 },
      );
    }
    const allAssets = await Assets.getAllAssets();
    const universe = allAssets.map((a) => ({
      id: a.id,
      symbol: a.symbol,
      name: a.name,
      kind: a.kind,
    }));
    const r = await runResearchAgent({ event, universe });
    return NextResponse.json({
      ok: !r.error,
      mode,
      trace_id: r.trace_id,
      rounds: r.rounds,
      cost_usd: r.cost_usd,
      classification: r.classification,
      error: r.error,
    });
  }

  if (mode === "verification" || mode === "debate") {
    if (!body.signal_id) {
      return NextResponse.json(
        { ok: false, error: `signal_id required for mode=${mode}` },
        { status: 400 },
      );
    }
    const signal = await Signals.getSignal(body.signal_id);
    if (!signal) {
      return NextResponse.json(
        { ok: false, error: `signal ${body.signal_id} not found` },
        { status: 404 },
      );
    }
    const asset = await Assets.getAssetById(signal.asset_id);
    const event = signal.triggered_by_event_id
      ? await Events.getEventById(signal.triggered_by_event_id)
      : undefined;

    if (mode === "verification") {
      const r = await runVerificationAgent({
        signal,
        asset_symbol: asset?.symbol ?? signal.asset_id,
        catalyst_iso: event
          ? new Date(event.release_time).toISOString()
          : new Date(signal.fired_at).toISOString(),
        catalyst_title: event?.title ?? "(no event title)",
        catalyst_author: event?.author ?? null,
      });
      return NextResponse.json({
        ok: !r.error,
        mode,
        trace_id: r.trace_id,
        rounds: r.rounds,
        cost_usd: r.cost_usd,
        verdict: r.verdict,
        error: r.error,
      });
    }

    // mode === "debate"
    const r = await runDebateAgent({
      signal,
      asset_symbol: asset?.symbol ?? signal.asset_id,
      catalyst_iso: event
        ? new Date(event.release_time).toISOString()
        : new Date(signal.fired_at).toISOString(),
      catalyst_title: event?.title ?? "(no event title)",
      catalyst_author: event?.author ?? null,
    });
    return NextResponse.json({
      ok: !r.error,
      mode,
      bull_trace_id: r.bull_trace_id,
      bear_trace_id: r.bear_trace_id,
      synthesizer_trace_id: r.synthesizer_trace_id,
      synthesis: r.synthesis,
      cost_usd: r.total_cost_usd,
      error: r.error,
    });
  }

  return NextResponse.json(
    {
      ok: false,
      error: `unknown mode: ${mode}. Use 'research', 'verification', or 'debate'.`,
    },
    { status: 400 },
  );
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
