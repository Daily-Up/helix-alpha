"use client";

/**
 * Agent trace renderer for the /signal/{id} audit page.
 *
 * The trace lives in `agent_traces` (Wave 2). Each row contains the full
 * step-by-step transcript of one agent run: the agent's thinking, every
 * tool it called with input/output, and the final structured output.
 *
 * Why this matters for the product story:
 *   The Wave 1 audit page showed "Claude said this." The Wave 2 audit
 *   page shows "Claude looked at outlets X, Y, Z, queried base rates,
 *   then synthesized this." That's the moat — chat-based competitors
 *   structurally can't surface this level of accountability.
 */

import { useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { fmtRelative } from "@/lib/format";
import { cn } from "@/components/ui/cn";

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
  search_outlet_coverage: "Search outlet coverage",
  query_asset_history: "Query asset history",
  query_event_type_stats: "Query event-type stats",
  submit_classification: "Submit classification",
};

export function AgentTraceCard({ trace }: { trace: AgentTraceData }) {
  const totalToolCalls = trace.steps.filter(
    (s) => s.type === "tool_call",
  ).length;
  const durationMs =
    trace.finished_at != null ? trace.finished_at - trace.started_at : null;

  return (
    <Card>
      <CardHeader className="flex-col items-stretch gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardTitle>Agent trace</CardTitle>
            <Badge tone={trace.status === "ok" ? "positive" : "negative"}>
              {trace.status}
            </Badge>
            <span className="text-[11px] text-fg-dim">
              {trace.agent_name} agent · {trace.rounds} round
              {trace.rounds === 1 ? "" : "s"} · {totalToolCalls} tool call
              {totalToolCalls === 1 ? "" : "s"}
            </span>
          </div>
          <div className="text-[11px] text-fg-dim">
            {durationMs != null ? `${(durationMs / 1000).toFixed(1)}s` : ""}
          </div>
        </div>
        <p className="text-xs text-fg-muted">
          Every decision below is recorded — the agent picked tools, called
          them with these inputs, got these outputs, and synthesized the
          final classification. No black-box step.
        </p>
      </CardHeader>
      <CardBody className="!p-0">
        <ol className="divide-y divide-line">
          {trace.steps.map((step, i) => (
            <li key={i}>
              <StepRow step={step} index={i} />
            </li>
          ))}
        </ol>
      </CardBody>
      {trace.error ? (
        <CardBody className="border-t border-line">
          <div className="rounded border border-negative/30 bg-negative/10 p-3 text-xs text-negative">
            <span className="font-medium">Agent error: </span>
            {trace.error}
          </div>
        </CardBody>
      ) : null}
    </Card>
  );
}

function StepRow({ step, index }: { step: AgentStep; index: number }) {
  if (step.type === "thinking") return <ThinkingStep step={step} index={index} />;
  if (step.type === "tool_call") return <ToolCallStep step={step} index={index} />;
  return <FinalStep step={step} index={index} />;
}

function StepHeader({
  index,
  round,
  badge,
  badgeTone,
  title,
  meta,
}: {
  index: number;
  round: number;
  badge: string;
  badgeTone: "default" | "accent" | "info" | "positive" | "negative";
  title: string;
  meta?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="tabular w-6 text-right font-mono text-fg-dim">
        {index + 1}.
      </span>
      <Badge tone={badgeTone}>{badge}</Badge>
      <span className="text-[10px] text-fg-dim">round {round}</span>
      <span className="text-fg">{title}</span>
      {meta ? <span className="text-[10px] text-fg-dim">{meta}</span> : null}
    </div>
  );
}

function ThinkingStep({
  step,
  index,
}: {
  step: AgentStepThinking;
  index: number;
}) {
  return (
    <div className="px-4 py-3">
      <StepHeader
        index={index}
        round={step.round}
        badge="THINK"
        badgeTone="default"
        title="Agent reasoning"
      />
      <p className="ml-8 mt-2 whitespace-pre-wrap text-xs text-fg-muted">
        {step.content}
      </p>
    </div>
  );
}

function ToolCallStep({
  step,
  index,
}: {
  step: AgentStepToolCall;
  index: number;
}) {
  const [open, setOpen] = useState(false);
  const label = TOOL_LABEL[step.tool] ?? step.tool;
  const errored = !!step.error;
  return (
    <div className="px-4 py-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="block w-full text-left"
      >
        <StepHeader
          index={index}
          round={step.round}
          badge={errored ? "ERR" : "CALL"}
          badgeTone={errored ? "negative" : "accent"}
          title={label}
          meta={`${step.duration_ms}ms`}
        />
        <div className="ml-8 mt-1 text-[10px] text-fg-dim">
          {open ? "▼ collapse" : "▶ inspect input + output"}
        </div>
      </button>
      {open ? (
        <div className="ml-8 mt-2 flex flex-col gap-2">
          <PayloadBlock label="Input" value={step.input} />
          <PayloadBlock
            label={errored ? "Error" : "Output"}
            value={step.error ?? step.output}
            tone={errored ? "negative" : "default"}
          />
        </div>
      ) : null}
    </div>
  );
}

function FinalStep({ step, index }: { step: AgentStepFinal; index: number }) {
  // The final output is the structured classification.
  const out = step.output as Record<string, unknown> | null;
  const reasoning =
    out && typeof out.reasoning === "string" ? out.reasoning : null;

  return (
    <div className="bg-accent/5 px-4 py-3">
      <StepHeader
        index={index}
        round={step.round}
        badge="FINAL"
        badgeTone="info"
        title="submit_classification"
      />
      {out ? (
        <div className="ml-8 mt-2 grid grid-cols-2 gap-2 text-[11px] md:grid-cols-4">
          <KV label="event_type" value={String(out.event_type ?? "—")} />
          <KV label="sentiment" value={String(out.sentiment ?? "—")} />
          <KV label="severity" value={String(out.severity ?? "—")} />
          <KV
            label="confidence"
            value={
              typeof out.confidence === "number"
                ? `${(out.confidence * 100).toFixed(0)}%`
                : "—"
            }
          />
        </div>
      ) : null}
      {reasoning ? (
        <div className="ml-8 mt-3 rounded border border-line bg-surface-2/50 p-2 text-xs text-fg-muted">
          <span className="text-[10px] uppercase tracking-wide text-fg-dim">
            Agent reasoning →{" "}
          </span>
          {reasoning}
        </div>
      ) : null}
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-fg-dim">
        {label}
      </div>
      <div className="font-mono text-fg">{value}</div>
    </div>
  );
}

function PayloadBlock({
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
        className={cn(
          "mt-1 max-h-72 overflow-auto rounded border border-line bg-bg p-2 font-mono text-[10px]",
          tone === "negative" ? "text-negative" : "text-fg-muted",
        )}
      >
        {text}
      </pre>
    </div>
  );
}

// Suppress unused import.
void fmtRelative;
