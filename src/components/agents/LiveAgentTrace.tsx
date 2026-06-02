"use client";

/**
 * Live-updating agent trace — editorial / product UI.
 *
 * Replaces the previous engineer-facing trace log (raw tool names,
 * iteration counters, JSON dumps) with a narrative read:
 *   - Conclusion first (event_type / sentiment / severity / conf%).
 *   - Reasoning paragraph below it, with raw tool names rewritten
 *     to plain English ("Event-type statistics" not "query_event_type_stats").
 *   - A compact evidence trail underneath listing the tools used, with
 *     a quiet "details" disclosure for the inspect-input-output panel.
 *
 * Still polls /api/data/trace?id=<traceId> every 800ms so the agent's
 * thinking shows up live.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import type {
  AgentStep,
  AgentTraceRow,
} from "@/lib/db/repos/agent-traces";
import { summarizeToolCall } from "./tool-summaries";

type AgentStepThinking = Extract<AgentStep, { type: "thinking" }>;
type AgentStepToolCall = Extract<AgentStep, { type: "tool_call" }>;
type AgentStepFinal = Extract<AgentStep, { type: "final" }>;

const POLL_INTERVAL_MS = 800;
const TIMEOUT_MS = 90_000;

// Plain-English labels for every internal tool name. New tools added
// to the agent should get an entry here so they don't fall back to
// the snake_case wire name.
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
    name
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/**
 * Replace any `tool_name_in_text` with its humanized version inside a
 * paragraph. The agent's own reasoning sometimes references tools by
 * their wire name — strip that from the user-facing output.
 */
function humanizeReasoning(text: string): string {
  let out = text;
  for (const [raw, friendly] of Object.entries(TOOL_LABEL)) {
    out = out.replaceAll(raw, friendly);
  }
  return out;
}

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
      if (res.status === 404) return;
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
        setError("agent didn't finish within 90s");
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

  // Separate the steps into the final classification, the thinking
  // turns (combined into a narrative paragraph), and the tool calls
  // (evidence trail).
  const final = useMemo(
    () =>
      trace?.steps.find((s): s is AgentStepFinal => s.type === "final") ?? null,
    [trace?.steps],
  );
  const thinking = useMemo(
    () =>
      (trace?.steps ?? []).filter(
        (s): s is AgentStepThinking => s.type === "thinking",
      ),
    [trace?.steps],
  );
  const toolCalls = useMemo(
    () =>
      (trace?.steps ?? []).filter(
        (s): s is AgentStepToolCall => s.type === "tool_call",
      ),
    [trace?.steps],
  );

  return (
    <Card>
      <CardHeader className="flex-col items-stretch gap-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <CardTitle>
            {final ? "Agent decision" : "Agent investigating"}
          </CardTitle>
          <span className="text-[11px] uppercase tracking-wider text-fg-dim">
            {trace?.agent_name === "verification"
              ? "verification agent"
              : trace?.agent_name === "debate"
                ? "debate agent"
                : "research agent"}
          </span>
          {!done ? <TypingDots /> : null}
          {durationS ? (
            <span className="ml-auto text-[11px] tabular text-fg-dim">
              {durationS}s
            </span>
          ) : null}
        </div>
      </CardHeader>

      <CardBody className="flex flex-col gap-4">
        {/* Conclusion — lead with the answer */}
        {final ? <Conclusion step={final} /> : null}

        {/* Reasoning — the agent's narrative, humanized */}
        {final == null && thinking.length === 0 ? (
          <div className="text-sm text-fg-muted">
            <TypingDots /> The agent is gathering evidence…
          </div>
        ) : null}
        {thinking.length > 0 && !final ? (
          <ReasoningPreview thinking={thinking} />
        ) : null}

        {/* Evidence — the tools the agent consulted */}
        {toolCalls.length > 0 ? (
          <EvidenceTrail calls={toolCalls} done={done} />
        ) : !final ? (
          <div className="text-xs text-fg-dim">
            <TypingDots /> Picking which sources to consult…
          </div>
        ) : null}

        {error ? (
          <div className="rounded border border-negative/30 bg-negative/5 p-2 text-xs text-negative">
            {error}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

// ─── Conclusion (final classification) ─────────────────────────────

function Conclusion({ step }: { step: AgentStepFinal }) {
  const out = step.output as Record<string, unknown> | null;
  if (!out) return null;
  const reasoning =
    typeof out.reasoning === "string"
      ? humanizeReasoning(out.reasoning)
      : null;

  const fields: Array<{ label: string; value: string }> = [
    {
      label: "Event type",
      value: titleCase(String(out.event_type ?? "—")),
    },
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

  // Verification verdicts have a different shape.
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

// ─── Reasoning preview (only shown WHILE running) ──────────────────

function ReasoningPreview({ thinking }: { thinking: AgentStepThinking[] }) {
  // Show the most recent thinking block so we see what the agent is
  // currently working on. Earlier ones are summarized into the final
  // reasoning paragraph once the agent concludes.
  const latest = thinking[thinking.length - 1];
  return (
    <div className="rounded border border-line bg-surface-2/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-fg-dim">
        Reasoning so far
      </div>
      <p className="mt-1 text-sm leading-relaxed text-fg-muted">
        {humanizeReasoning(latest.content)}
      </p>
    </div>
  );
}

// ─── Evidence trail (compact tool list) ────────────────────────────

function EvidenceTrail({
  calls,
  done,
}: {
  calls: AgentStepToolCall[];
  done: boolean;
}) {
  // De-dupe: if the agent calls the same tool twice with the same
  // shape, the user doesn't need to see both rows unless they want
  // to inspect details. Keep first call's data, count subsequent
  // calls under it.
  const grouped = useMemo(() => {
    const map = new Map<
      string,
      { call: AgentStepToolCall; count: number }
    >();
    for (const c of calls) {
      const key = c.tool;
      const ex = map.get(key);
      if (ex) {
        ex.count += 1;
      } else {
        map.set(key, { call: c, count: 1 });
      }
    }
    return [...map.values()];
  }, [calls]);

  return (
    <div>
      <div className="mb-2 text-[10px] uppercase tracking-wider text-fg-dim">
        Evidence consulted{!done ? " (still gathering)" : ""}
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
  const [showRaw, setShowRaw] = useState(false);
  const errored = !!call.error;
  const summary = useMemo(
    () => summarizeToolCall(call.tool, call.input, call.output),
    [call.tool, call.input, call.output],
  );
  const hasSummary = !!summary.asked || !!summary.found;

  return (
    <li className="border-t border-line first:border-t-0 py-2">
      <div className="flex items-baseline gap-3 text-sm">
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
      </div>

      {hasSummary || errored ? (
        <div className="ml-5 mt-1 flex flex-col gap-0.5 text-xs">
          {summary.asked ? (
            <div className="flex gap-2 leading-relaxed">
              <span className="shrink-0 text-fg-dim">Asked for:</span>
              <span className="text-fg-muted">{summary.asked}</span>
            </div>
          ) : null}
          {errored ? (
            <div className="flex gap-2 leading-relaxed">
              <span className="shrink-0 text-fg-dim">Error:</span>
              <span className="text-negative">{call.error}</span>
            </div>
          ) : summary.found ? (
            <div className="flex gap-2 leading-relaxed">
              <span className="shrink-0 text-fg-dim">Found:</span>
              <span className="text-fg">{summary.found}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="ml-5 mt-1">
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className="text-[10px] text-fg-dim transition-colors hover:text-fg-muted"
        >
          {showRaw ? "▾ hide raw" : "▸ raw payload"}
        </button>
        {showRaw ? (
          <div className="mt-1 flex flex-col gap-2">
            <PayloadDisclosure label="Input" value={call.input} />
            <PayloadDisclosure
              label={errored ? "Error" : "Output"}
              value={errored ? call.error : call.output}
              tone={errored ? "negative" : "default"}
            />
          </div>
        ) : null}
      </div>
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

// ─── small helpers ─────────────────────────────────────────────────

function titleCase(s: string): string {
  if (!s) return s;
  return s
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
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
