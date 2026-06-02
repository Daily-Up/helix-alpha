/**
 * GET /api/data/trace?id=<trace_id>
 *
 * Fetch a single agent trace by id. Used by client components that
 * poll while an agent is running to render its steps live as they're
 * persisted (the agent runner writes each step to the DB as it
 * completes — thinking blocks, tool calls, tool results, final
 * classification).
 *
 * Returns 404 if the trace doesn't exist (yet — there's a brief
 * window after the start signal before the row appears).
 */

import { NextResponse } from "next/server";
import { AgentTraces } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "id query param required" },
      { status: 400 },
    );
  }

  const trace = await AgentTraces.getTrace(id);
  if (!trace) {
    return NextResponse.json({ ok: false, error: "trace not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, trace });
}
