/**
 * GET /api/data/agents
 *
 * Operational summary for the /agents observability page.
 *
 * Returns:
 *   - recent traces (last 50, newest first)
 *   - 24h totals: runs, tokens, cost
 *   - tool-call frequency over last 24h (which tools the agents lean on)
 *   - per-agent status breakdown
 */

import { NextResponse } from "next/server";
import { all, AgentTraces } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ToolFreq {
  tool: string;
  calls: number;
}

interface AgentSummary {
  agent_name: string;
  runs: number;
  ok: number;
  errored: number;
  total_cost_usd: number;
}

export async function GET() {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

  const recent = await AgentTraces.listRecentTraces(50);

  // Aggregate 24h numbers and tool freq from a raw query — faster than
  // pulling 1000 traces into memory.
  interface Tot {
    runs: number;
    tokens_input: number;
    tokens_output: number;
    tokens_cached: number;
    cost_usd: number;
  }
  const totals = (
    await all<Tot>(
      `SELECT COUNT(*) AS runs,
              COALESCE(SUM(tokens_input), 0) AS tokens_input,
              COALESCE(SUM(tokens_output), 0) AS tokens_output,
              COALESCE(SUM(tokens_cached), 0) AS tokens_cached,
              COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM agent_traces
       WHERE started_at >= ?`,
      [dayAgo],
    )
  )[0] ?? { runs: 0, tokens_input: 0, tokens_output: 0, tokens_cached: 0, cost_usd: 0 };

  const perAgent = await all<AgentSummary>(
    `SELECT agent_name,
            COUNT(*) AS runs,
            SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errored,
            COALESCE(SUM(cost_usd), 0) AS total_cost_usd
     FROM agent_traces
     WHERE started_at >= ?
     GROUP BY agent_name
     ORDER BY runs DESC`,
    [dayAgo],
  );

  // Tool frequency from steps JSON. SQLite doesn't have a great JSON
  // unroll so we count in JS over the recent traces window.
  const tool_freq_24h = new Map<string, number>();
  const sinceCutoff = dayAgo;
  for (const t of recent) {
    if (t.started_at < sinceCutoff) continue;
    for (const step of t.steps) {
      if (step.type === "tool_call") {
        tool_freq_24h.set(
          step.tool,
          (tool_freq_24h.get(step.tool) ?? 0) + 1,
        );
      }
    }
  }
  const tool_freq: ToolFreq[] = [...tool_freq_24h.entries()]
    .map(([tool, calls]) => ({ tool, calls }))
    .sort((a, b) => b.calls - a.calls);

  return NextResponse.json({
    recent,
    totals_24h: {
      runs: Number(totals.runs),
      tokens_input: Number(totals.tokens_input),
      tokens_output: Number(totals.tokens_output),
      tokens_cached: Number(totals.tokens_cached),
      cost_usd: Number(totals.cost_usd),
    },
    per_agent_24h: perAgent.map((p) => ({
      agent_name: p.agent_name,
      runs: Number(p.runs),
      ok: Number(p.ok),
      errored: Number(p.errored),
      total_cost_usd: Number(p.total_cost_usd),
    })),
    tool_freq_24h: tool_freq,
  });
}
