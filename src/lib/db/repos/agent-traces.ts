/**
 * Repository — `agent_traces`.
 *
 * One row per agent run. The `steps` column is a JSON-encoded array of
 * AgentStep objects — the full transcript of what the agent thought, what
 * tools it called, and what each tool returned. The audit page renders
 * these inline so anyone inspecting a signal can see the agent's full
 * reasoning chain.
 */

import { all, get, run } from "../client";

/**
 * One observable thing the agent did. The audit UI renders a list of these
 * in order. New step types should be additive (don't repurpose existing
 * fields) so old traces continue to render.
 */
export type AgentStep =
  | {
      type: "thinking";
      round: number;
      content: string;
      ts_ms: number;
    }
  | {
      type: "tool_call";
      round: number;
      tool: string;
      input: unknown;
      output: unknown;
      duration_ms: number;
      error?: string;
      ts_ms: number;
    }
  | {
      type: "final";
      round: number;
      output: unknown;
      ts_ms: number;
    };

export interface AgentTraceRow {
  id: string;
  agent_name: string;
  event_id: string | null;
  signal_id: string | null;
  started_at: number;
  finished_at: number | null;
  status: "running" | "ok" | "error";
  rounds: number;
  steps: AgentStep[];
  final_output: unknown | null;
  tokens_input: number;
  tokens_output: number;
  tokens_cached: number;
  cost_usd: number;
  model: string | null;
  error: string | null;
}

interface RawRow {
  id: string;
  agent_name: string;
  event_id: string | null;
  signal_id: string | null;
  started_at: number;
  finished_at: number | null;
  status: "running" | "ok" | "error";
  rounds: number;
  steps: string;
  final_output: string | null;
  tokens_input: number;
  tokens_output: number;
  tokens_cached: number;
  cost_usd: number;
  model: string | null;
  error: string | null;
}

function rowToTrace(r: RawRow): AgentTraceRow {
  return {
    ...r,
    steps: safeJson<AgentStep[]>(r.steps, []),
    final_output: r.final_output ? safeJson<unknown>(r.final_output, null) : null,
  };
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Insert a trace row in the 'running' state. The agent loop updates it
 *  with steps as they happen, then finalizes via `finishTrace`. */
export async function startTrace(input: {
  id: string;
  agent_name: string;
  event_id?: string | null;
  signal_id?: string | null;
  model?: string | null;
}): Promise<void> {
  await run(
    `INSERT INTO agent_traces
       (id, agent_name, event_id, signal_id, status, model)
     VALUES (?, ?, ?, ?, 'running', ?)`,
    [
      input.id,
      input.agent_name,
      input.event_id ?? null,
      input.signal_id ?? null,
      input.model ?? null,
    ],
  );
}

/** Append one step to a running trace and bump `rounds` if applicable. */
export async function appendStep(
  traceId: string,
  step: AgentStep,
): Promise<void> {
  const existing = await get<{ steps: string; rounds: number }>(
    `SELECT steps, rounds FROM agent_traces WHERE id = ?`,
    [traceId],
  );
  const stepsArr = existing ? safeJson<AgentStep[]>(existing.steps, []) : [];
  stepsArr.push(step);
  const newRounds = step.round + 1 > (existing?.rounds ?? 0)
    ? step.round + 1
    : (existing?.rounds ?? 0);
  await run(
    `UPDATE agent_traces SET steps = ?, rounds = ? WHERE id = ?`,
    [JSON.stringify(stepsArr), newRounds, traceId],
  );
}

/** Mark a trace as finished. Pass status='ok' on success, status='error'
 *  with an error message on failure. */
export async function finishTrace(
  traceId: string,
  input: {
    status: "ok" | "error";
    final_output?: unknown;
    error?: string;
    tokens?: { input: number; output: number; cached: number };
    cost_usd?: number;
  },
): Promise<void> {
  await run(
    `UPDATE agent_traces
       SET finished_at = unixepoch() * 1000,
           status = ?,
           final_output = ?,
           error = ?,
           tokens_input = ?,
           tokens_output = ?,
           tokens_cached = ?,
           cost_usd = ?
     WHERE id = ?`,
    [
      input.status,
      input.final_output ? JSON.stringify(input.final_output) : null,
      input.error ?? null,
      input.tokens?.input ?? 0,
      input.tokens?.output ?? 0,
      input.tokens?.cached ?? 0,
      input.cost_usd ?? 0,
      traceId,
    ],
  );
}

/** Read a single trace by id. */
export async function getTrace(id: string): Promise<AgentTraceRow | undefined> {
  const row = await get<RawRow>(
    `SELECT * FROM agent_traces WHERE id = ?`,
    [id],
  );
  return row ? rowToTrace(row) : undefined;
}

/** Latest trace for an event (most recent across all agent names). */
export async function getTraceForEvent(
  eventId: string,
): Promise<AgentTraceRow | undefined> {
  const row = await get<RawRow>(
    `SELECT * FROM agent_traces
     WHERE event_id = ?
     ORDER BY started_at DESC
     LIMIT 1`,
    [eventId],
  );
  return row ? rowToTrace(row) : undefined;
}

/** All traces for an event, oldest first. */
export async function listTracesForEvent(
  eventId: string,
): Promise<AgentTraceRow[]> {
  const rows = await all<RawRow>(
    `SELECT * FROM agent_traces
     WHERE event_id = ?
     ORDER BY started_at ASC`,
    [eventId],
  );
  return rows.map(rowToTrace);
}

/** Latest trace for a signal. */
export async function getTraceForSignal(
  signalId: string,
): Promise<AgentTraceRow | undefined> {
  const row = await get<RawRow>(
    `SELECT * FROM agent_traces
     WHERE signal_id = ?
     ORDER BY started_at DESC
     LIMIT 1`,
    [signalId],
  );
  return row ? rowToTrace(row) : undefined;
}

/** Recent traces across the system, newest first. Used by the agents
 *  observability page (Wave 2 / Wave 3).
 *
 *  Traces that have been stuck in `status='running'` longer than
 *  STUCK_AFTER_MS are coerced to `error` at read time so the
 *  observability UI doesn't show a forever-spinning row when a
 *  process crashed mid-run before finally{} could close the trace.
 *  We rewrite the in-memory row only — no DB mutation here. A
 *  periodic cleanup script can permanently fix the row if desired.
 */
const STUCK_AFTER_MS = 5 * 60 * 1000;

export async function listRecentTraces(limit = 50): Promise<AgentTraceRow[]> {
  const rows = await all<RawRow>(
    `SELECT * FROM agent_traces
     ORDER BY started_at DESC
     LIMIT ?`,
    [limit],
  );
  const now = Date.now();
  return rows.map((r) => {
    const trace = rowToTrace(r);
    if (
      trace.status === "running" &&
      trace.started_at < now - STUCK_AFTER_MS
    ) {
      return {
        ...trace,
        status: "error" as const,
        error: trace.error ?? "Stuck — never closed (likely a crash mid-run)",
      };
    }
    return trace;
  });
}
