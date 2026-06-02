"use client";

/**
 * Live-updating agent trace.
 *
 * Polls /api/data/trace?id=<traceId> every 800ms and renders each
 * step as it appears in the DB. The agent runner persists each
 * thinking block, tool call, tool result, and final classification
 * the moment it happens — so by polling we get a "live typing" feel
 * even though the underlying agent isn't using SSE.
 *
 * Stops polling once the trace status flips to "ok" or "error", or
 * after the safety-cap timeout.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import type {
  AgentStep,
  AgentTraceRow,
} from "@/lib/db/repos/agent-traces";

// Narrowed step types — AgentStep is a discriminated union but the
// individual cases aren't exported, so we derive them locally.
type AgentStepThinking = Extract<AgentStep, { type: "thinking" }>;
type AgentStepToolCall = Extract<AgentStep, { type: "tool_call" }>;
type AgentStepFinal = Extract<AgentStep, { type: "final" }>;

const POLL_INTERVAL_MS = 800;
const TIMEOUT_MS = 90_000;

const TOOL_LABEL: Record<string, string> = {
  search_outlet_coverage: "Search outlet coverage",
  query_asset_history: "Query asset history",
  query_event_type_stats: "Query event-type stats",
  fetch_full_article: "Fetch full article",
  query_base_rate: "Query base rate",
  query_price_around_catalyst: "Query price tape",
  submit_classification: "Submit classification",
  submit_verdict: "Submit verdict",
};

export function LiveAgentTrace({
  traceId,
  onComplete,
}: {
  traceId: string;
  onComplete?: (trace: AgentTraceRow) => void;
}) {
  const [trace, setTrace] = useState<AgentTraceRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const fetchOnce = useCallback(async () => {
    try {
      const res = await fetch(`/api/data/trace?id=${traceId}`);
      if (res.status === 404) return; // trace row hasn't been inserted yet
      const json = (await res.json()) as {
        ok: boolean;
        trace?: AgentTraceRow;
        error?: string;
      };
      if (!json.ok || !json.trace) {
        setError(json.error ?? "load failed");
        return;
      }
      setTrace(json.trace);
      if (json.trace.status !== "running") {
        setDone(true);
        onComplete?.(json.trace);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [traceId, onComplete]);

  useEffect(() => {
    let cancelled = false;
    const start = Date.now();
    fetchOnce();
    const interval = setInterval(() => {
      if (cancelled || done) {
        clearInterval(interval);
        return;
      }
      if (Date.now() - start > TIMEOUT_MS) {
        clearInterval(interval);
        setError("agent didn't finish within 90s — check the trace history later");
        return;
      }
      fetchOnce();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fetchOnce, done]);

  const durationS = useMemo(() => {
    if (!trace) return null;
    const end = trace.finished_at ?? Date.now();
    return ((end - trace.started_at) / 1000).toFixed(1);
  }, [trace]);

  return (
    <Card>
      <CardHeader className="flex-col items-stretch gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Agent trace</CardTitle>
          {trace ? (
            <Badge
              tone={
                trace.status === "ok"
                  ? "positive"
                  : trace.status === "error"
                    ? "negative"
                    : "accent"
              }
            >
              {trace.status === "running" ? "running…" : trace.status}
            </Badge>
          ) : (
            <Badge tone="accent">starting…</Badge>
          )}
          {trace ? (
            <span className="text-[11px] text-fg-dim">
              {trace.agent_name} agent · {trace.rounds} round
              {trace.rounds === 1 ? "" : "s"}
            </span>
          ) : null}
          {durationS ? (
            <span className="ml-auto text-[11px] text-fg-dim">
              {durationS}s
            </span>
          ) : null}
        </div>
      </CardHeader>
      <CardBody className="!p-0">
        {trace?.steps?.length ? (
          <ol className="divide-y divide-line">
            {trace.steps.map((step, i) => (
              <li key={i}>
                <StepRow step={step} index={i} />
              </li>
            ))}
            {!done ? (
              <li className="px-4 py-3 text-xs text-fg-dim">
                <TypingDots /> agent is still thinking…
              </li>
            ) : null}
          </ol>
        ) : (
          <div className="p-4 text-xs text-fg-muted">
            <TypingDots /> starting agent…
          </div>
        )}
      </CardBody>
      {error ? (
        <div className="border-t border-negative/30 bg-negative/5 px-4 py-2 text-xs text-negative">
          {error}
        </div>
      ) : null}
    </Card>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block h-1 w-1 animate-pulse rounded-full bg-accent"
        style={{ animationDelay: "0ms" }}
      />
      <span
        className="inline-block h-1 w-1 animate-pulse rounded-full bg-accent"
        style={{ animationDelay: "200ms" }}
      />
      <span
        className="inline-block h-1 w-1 animate-pulse rounded-full bg-accent"
        style={{ animationDelay: "400ms" }}
      />
    </span>
  );
}

function StepRow({ step, index }: { step: AgentStep; index: number }) {
  if (step.type === "thinking")
    return <ThinkingStep step={step} index={index} />;
  if (step.type === "tool_call")
    return <ToolCallStep step={step} index={index} />;
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
  const label = TOOL_LABEL[step.tool] ?? step.tool;
  const errored = !!step.error;
  return (
    <div className="px-4 py-3">
      <StepHeader
        index={index}
        round={step.round}
        badge={errored ? "ERR" : "CALL"}
        badgeTone={errored ? "negative" : "accent"}
        title={label}
        meta={`${step.duration_ms}ms`}
      />
      {errored ? (
        <p className="ml-8 mt-2 text-xs text-negative">{step.error}</p>
      ) : null}
    </div>
  );
}

function FinalStep({ step, index }: { step: AgentStepFinal; index: number }) {
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
        title="Classification"
      />
      {out ? (
        <div className="ml-8 mt-2 grid grid-cols-2 gap-2 text-[11px] md:grid-cols-4">
          {(["event_type", "sentiment", "severity", "confidence"] as const).map(
            (k) => {
              const v = out[k];
              const displayValue =
                k === "confidence" && typeof v === "number"
                  ? `${(v * 100).toFixed(0)}%`
                  : String(v ?? "—");
              return (
                <div key={k}>
                  <div className="text-[10px] uppercase tracking-wider text-fg-dim">
                    {k}
                  </div>
                  <div className={cn("font-mono text-fg")}>{displayValue}</div>
                </div>
              );
            },
          )}
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
