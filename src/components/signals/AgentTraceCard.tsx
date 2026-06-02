"use client";

/**
 * Agent trace card for the /signal/{id} audit page.
 *
 * Renders a completed agent trace in the same editorial style as the
 * live trace shown when judges click "Run live agent" — leads with
 * the conclusion, summarizes reasoning in prose with humanized tool
 * names, and tucks evidence + raw payloads behind a quiet disclosure.
 *
 * Why this matters for the product story:
 *   The Wave 1 audit page showed "Claude said this." The Wave 2 audit
 *   page shows "the agent looked at outlets X, Y, Z, queried base
 *   rates, then concluded this." That's the moat — chat-based
 *   competitors structurally can't surface this level of accountability.
 */

import { useMemo, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";

interface AgentStepThinking {
  type: "thinking";
  round: number;
  content: string;
  ts_ms: number;
}
interface AgentStepToolCall {
  type: "tool_call";
  round: number;
  tool: string;
  input: unknown;
  output: unknown;
  duration_ms: number;
  error?: string;
  ts_ms: number;
}
interface AgentStepFinal {
  type: "final";
  round: number;
  output: unknown;
  ts_ms: number;
}
type AgentStep = AgentStepThinking | AgentStepToolCall | AgentStepFinal;

export interface AgentTraceData {
  id: string;
  agent_name: string;
  status: "running" | "ok" | "error";
  rounds: number;
  started_at: number;
  finished_at: number | null;
  steps: AgentStep[];
  tokens_input: number;
  tokens_output: number;
  tokens_cached: number;
  cost_usd: number;
  model: string | null;
  error: string | null;
}

const TOOL_LABEL: Record<string, string> = {
  search_outlet_coverage: "Outlet coverage check",
  query_asset_history: "Asset history",
  query_event_type_stats: "Event-type statistics",
  fetch_full_article: "Full article",
  query_base_rate: "Base rate",
  query_price_around_catalyst: "Price action around catalyst",
  submit_classification: "Final classification",
  submit_verdict: "Verdict",
};

function humanizeTool(name: string): string {
  return (
    TOOL_LABEL[name] ??
    name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function humanizeReasoning(text: string): string {
  let out = text;
  for (const [raw, friendly] of Object.entries(TOOL_LABEL)) {
    out = out.replaceAll(raw, friendly);
  }
  return out;
}

function titleCase(s: string): string {
  if (!s) return s;
  return s
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export function AgentTraceCard({ trace }: { trace: AgentTraceData }) {
  const durationMs =
    trace.finished_at != null ? trace.finished_at - trace.started_at : null;

  const final = useMemo(
    () =>
      trace.steps.find((s): s is AgentStepFinal => s.type === "final") ?? null,
    [trace.steps],
  );
  const toolCalls = useMemo(
    () =>
      trace.steps.filter(
        (s): s is AgentStepToolCall => s.type === "tool_call",
      ),
    [trace.steps],
  );

  const agentLabel =
    trace.agent_name === "verification"
      ? "verification agent"
      : trace.agent_name === "debate"
        ? "debate agent"
        : "research agent";

  return (
    <Card>
      <CardHeader className="flex-col items-stretch gap-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <CardTitle>Agent decision</CardTitle>
          <span className="text-[11px] uppercase tracking-wider text-fg-dim">
            {agentLabel}
          </span>
          {durationMs != null ? (
            <span className="ml-auto text-[11px] tabular text-fg-dim">
              {(durationMs / 1000).toFixed(1)}s
            </span>
          ) : null}
        </div>
      </CardHeader>

      <CardBody className="flex flex-col gap-4">
        {final ? <Conclusion step={final} /> : null}
        {toolCalls.length > 0 ? <EvidenceTrail calls={toolCalls} /> : null}

        {trace.error ? (
          <div className="rounded border border-negative/30 bg-negative/10 p-2 text-xs text-negative">
            <span className="font-medium">Agent error: </span>
            {trace.error}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

// ─── Conclusion ────────────────────────────────────────────────────

function Conclusion({ step }: { step: AgentStepFinal }) {
  const out = step.output as Record<string, unknown> | null;
  if (!out) return null;
  const reasoning =
    typeof out.reasoning === "string"
      ? humanizeReasoning(out.reasoning)
      : null;

  if (out.verdict && typeof out.verdict === "string") {
    return (
      <div>
        <div className="text-[10px] uppercase tracking-wider text-fg-dim">
          Verdict
        </div>
        <div className="mt-1 font-mono text-base text-fg">
          {titleCase(out.verdict)}
        </div>
        {reasoning ? (
          <p className="mt-3 text-sm leading-relaxed text-fg-muted">
            {reasoning}
          </p>
        ) : null}
      </div>
    );
  }

  const fields: Array<{ label: string; value: string }> = [
    { label: "Event type", value: titleCase(String(out.event_type ?? "—")) },
    { label: "Sentiment", value: titleCase(String(out.sentiment ?? "—")) },
    { label: "Severity", value: titleCase(String(out.severity ?? "—")) },
    {
      label: "Confidence",
      value:
        typeof out.confidence === "number"
          ? `${(out.confidence * 100).toFixed(0)}%`
          : "—",
    },
  ];

  return (
    <div>
      <div className="grid grid-cols-2 gap-y-3 md:grid-cols-4">
        {fields.map((f) => (
          <div key={f.label}>
            <div className="text-[10px] uppercase tracking-wider text-fg-dim">
              {f.label}
            </div>
            <div className="mt-1 font-mono text-sm text-fg">{f.value}</div>
          </div>
        ))}
      </div>
      {reasoning ? (
        <p className="mt-4 text-sm leading-relaxed text-fg-muted">
          {reasoning}
        </p>
      ) : null}
    </div>
  );
}

// ─── Evidence trail ────────────────────────────────────────────────

function EvidenceTrail({ calls }: { calls: AgentStepToolCall[] }) {
  // Group multiple calls to the same tool together.
  const grouped = useMemo(() => {
    const map = new Map<
      string,
      { call: AgentStepToolCall; count: number }
    >();
    for (const c of calls) {
      const ex = map.get(c.tool);
      if (ex) ex.count += 1;
      else map.set(c.tool, { call: c, count: 1 });
    }
    return [...map.values()];
  }, [calls]);

  return (
    <div>
      <div className="mb-2 text-[10px] uppercase tracking-wider text-fg-dim">
        Evidence consulted
      </div>
      <ul className="flex flex-col">
        {grouped.map((g, i) => (
          <EvidenceRow key={i} call={g.call} count={g.count} />
        ))}
      </ul>
    </div>
  );
}

function EvidenceRow({
  call,
  count,
}: {
  call: AgentStepToolCall;
  count: number;
}) {
  const [open, setOpen] = useState(false);
  const errored = !!call.error;
  return (
    <li className="border-t border-line first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-3 py-2 text-left text-sm transition-colors hover:bg-surface-2/50"
      >
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{
            background: errored ? "#e06c66" : "#5cc97a",
            opacity: 0.8,
          }}
        />
        <span className={errored ? "text-negative" : "text-fg"}>
          {humanizeTool(call.tool)}
          {count > 1 ? (
            <span className="ml-2 text-xs text-fg-dim">×{count}</span>
          ) : null}
        </span>
        <span className="ml-auto tabular text-[11px] text-fg-dim">
          {call.duration_ms}ms
        </span>
        <span className="text-[10px] text-fg-dim">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-2 px-4 pb-3 pt-1">
          <PayloadDisclosure label="Asked for" value={call.input} />
          <PayloadDisclosure
            label={errored ? "Error" : "Found"}
            value={errored ? call.error : call.output}
            tone={errored ? "negative" : "default"}
          />
        </div>
      ) : null}
    </li>
  );
}

function PayloadDisclosure({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: unknown;
  tone?: "default" | "negative";
}) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-fg-dim">
        {label}
      </div>
      <pre
        className={
          tone === "negative"
            ? "mt-1 max-h-72 overflow-auto rounded border border-line bg-bg p-2 font-mono text-[10px] text-negative"
            : "mt-1 max-h-72 overflow-auto rounded border border-line bg-bg p-2 font-mono text-[10px] text-fg-muted"
        }
      >
        {text}
      </pre>
    </div>
  );
}
