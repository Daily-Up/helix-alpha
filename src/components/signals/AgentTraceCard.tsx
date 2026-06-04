"use client";

/**
 * Agent trace card for the /signal/{id} audit page.
 *
 * Renders a completed agent trace in the same editorial style as the
 * /briefing hero (Fraunces serif headline, generous spacing,
 * hairline dividers, JetBrains Mono small-caps kickers).
 *
 * Shares its layout with `LiveAgentTrace` so the live-typing view
 * judges see while an agent is running, and the historical view
 * persisted on the signal audit page, look the same.
 */

import { useMemo, useState } from "react";
import { summarizeToolCall } from "@/components/agents/tool-summaries";

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

// ─── Design tokens (match BriefingPage) ─────────────────────────────
const TEXT_BRAND = "#ede4d3";
const TEXT_MUTED = "#8a857a";
const TEXT_DIM = "#5d584e";
const ACCENT = "#d97757";
const POSITIVE = "#5cc97a";
const NEGATIVE = "#e06c66";
const BORDER_QUIET = "rgba(237, 228, 211, 0.08)";

const TOOL_LABEL: Record<string, string> = {
  search_outlet_coverage: "Outlet coverage",
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
  const durationS = durationMs != null ? (durationMs / 1000).toFixed(1) : null;

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

  // Agent labels — actual agent_name values are `research`,
  // `verification`, `debate-bull`, `debate-bear`, `debate-synth`.
  // Previously this checked `=== "debate"` which never matched any
  // of the three debate variants, so they ALL fell through to
  // "Research agent" — producing duplicate "RESEARCH AGENT" labels
  // on every multi-agent audit page.
  const agentLabel = (() => {
    const name = trace.agent_name;
    if (name === "verification") return "Verification agent";
    if (name === "debate-bull") return "Debate · Bull case";
    if (name === "debate-bear") return "Debate · Bear case";
    if (name === "debate-synth") return "Debate · Synthesis";
    if (name === "research") return "Research agent";
    return name; // fall back to raw name for any new agent type
  })();

  return (
    <article
      className="relative flex flex-col"
      style={{
        paddingLeft: "26px",
        paddingRight: "26px",
        paddingTop: "32px",
        paddingBottom: "32px",
        borderTop: `1px solid ${BORDER_QUIET}`,
        borderBottom: `1px solid ${BORDER_QUIET}`,
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          top: "32px",
          bottom: "32px",
          width: "2px",
          background: ACCENT,
        }}
      />

      <Kicker label={agentLabel} status={trace.status} durationS={durationS} />

      {final ? <Conclusion step={final} /> : null}

      {toolCalls.length > 0 ? <Evidence calls={toolCalls} /> : null}

      {trace.error ? (
        <p
          className="font-[var(--font-inter)]"
          style={{
            fontSize: "12px",
            color: NEGATIVE,
            marginTop: "20px",
            fontStyle: "italic",
          }}
        >
          Agent error — {trace.error}
        </p>
      ) : null}
    </article>
  );
}

function Kicker({
  label,
  status,
  durationS,
}: {
  label: string;
  status: "running" | "ok" | "error";
  durationS: string | null;
}) {
  const statusColor =
    status === "ok" ? POSITIVE : status === "error" ? NEGATIVE : ACCENT;
  const statusLabel =
    status === "ok" ? "Complete" : status === "error" ? "Error" : "Live";
  return (
    <div
      className="flex items-baseline gap-3 flex-wrap"
      style={{ marginBottom: "20px" }}
    >
      <span
        className="font-[var(--font-jetbrains-mono)]"
        style={{
          fontSize: "10px",
          fontWeight: 600,
          letterSpacing: "0.22em",
          color: ACCENT,
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <span style={{ color: TEXT_DIM, fontSize: "11px" }}>·</span>
      <span
        className="font-[var(--font-jetbrains-mono)]"
        style={{
          fontSize: "10px",
          fontWeight: 600,
          letterSpacing: "0.22em",
          color: statusColor,
          textTransform: "uppercase",
        }}
      >
        {statusLabel}
      </span>
      {durationS ? (
        <span
          className="font-[var(--font-jetbrains-mono)] tabular-nums ml-auto"
          style={{ fontSize: "11px", color: TEXT_MUTED }}
        >
          {durationS}s
        </span>
      ) : null}
    </div>
  );
}

function Conclusion({ step }: { step: AgentStepFinal }) {
  const out = step.output as Record<string, unknown> | null;
  if (!out) return null;
  const reasoning =
    typeof out.reasoning === "string"
      ? humanizeReasoning(out.reasoning)
      : null;

  // Verification agent emits {decision: "kill"|"confirm"|"downgrade",
  // reasoning, red_flags}. Debate-synthesizer emits a similar shape.
  // Both should render with the decision as the hero word.
  const decision =
    (typeof out.decision === "string" && out.decision) ||
    (typeof out.verdict === "string" && out.verdict) ||
    null;
  if (decision) {
    const decisionColor =
      decision === "confirm"
        ? POSITIVE
        : decision === "kill"
          ? NEGATIVE
          : decision === "downgrade"
            ? ACCENT
            : TEXT_BRAND;
    const redFlags = Array.isArray(out.red_flags)
      ? out.red_flags.filter((x): x is string => typeof x === "string")
      : [];
    return (
      <>
        <h2
          className="font-[var(--font-fraunces)]"
          style={{
            fontSize: "32px",
            fontWeight: 400,
            lineHeight: 1.2,
            letterSpacing: "-0.02em",
            color: decisionColor,
          }}
        >
          {titleCase(decision)}
        </h2>
        {redFlags.length > 0 ? (
          <div
            className="font-[var(--font-jetbrains-mono)] flex flex-wrap items-baseline gap-x-4 gap-y-1"
            style={{
              marginTop: "12px",
              fontSize: "11px",
              letterSpacing: "0.16em",
              color: NEGATIVE,
              textTransform: "uppercase",
            }}
          >
            <span style={{ color: TEXT_DIM }}>Red flags</span>
            {redFlags.map((f, i) => (
              <span key={i}>{f.replace(/_/g, " ")}</span>
            ))}
          </div>
        ) : null}
        {reasoning ? (
          <p
            className="font-[var(--font-inter)]"
            style={{
              fontSize: "15px",
              lineHeight: 1.7,
              color: TEXT_MUTED,
              marginTop: "20px",
              maxWidth: "70ch",
            }}
          >
            {reasoning}
          </p>
        ) : null}
      </>
    );
  }

  const eventType = String(out.event_type ?? "—");
  const sentiment = String(out.sentiment ?? "—");
  const severity = String(out.severity ?? "—");
  const conf =
    typeof out.confidence === "number"
      ? `${(out.confidence * 100).toFixed(0)}%`
      : null;
  const sentimentColor =
    sentiment === "positive"
      ? POSITIVE
      : sentiment === "negative"
        ? NEGATIVE
        : TEXT_MUTED;

  return (
    <>
      <h2
        className="font-[var(--font-fraunces)]"
        style={{
          fontSize: "28px",
          fontWeight: 400,
          lineHeight: 1.22,
          letterSpacing: "-0.02em",
          color: TEXT_BRAND,
        }}
      >
        {titleCase(eventType)}{" "}
        <span style={{ color: sentimentColor }}>· {titleCase(sentiment)}</span>
      </h2>
      <div
        className="flex flex-wrap items-baseline gap-x-6 gap-y-2 font-[var(--font-jetbrains-mono)]"
        style={{
          marginTop: "12px",
          fontSize: "11px",
          letterSpacing: "0.16em",
          color: TEXT_DIM,
          textTransform: "uppercase",
        }}
      >
        <span>Severity {titleCase(severity)}</span>
        {conf ? <span style={{ color: ACCENT }}>{conf} confidence</span> : null}
      </div>
      {reasoning ? (
        <p
          className="font-[var(--font-inter)]"
          style={{
            fontSize: "15px",
            lineHeight: 1.7,
            color: TEXT_MUTED,
            marginTop: "24px",
            maxWidth: "70ch",
          }}
        >
          {reasoning}
        </p>
      ) : null}
    </>
  );
}

function Evidence({ calls }: { calls: AgentStepToolCall[] }) {
  const grouped = useMemo(() => {
    const out: Array<{ call: AgentStepToolCall; count: number }> = [];
    for (const c of calls) {
      const last = out[out.length - 1];
      if (last && last.call.tool === c.tool) {
        last.count += 1;
        last.call = c;
      } else {
        out.push({ call: c, count: 1 });
      }
    }
    return out;
  }, [calls]);

  return (
    <section style={{ marginTop: "40px" }}>
      <div
        className="font-[var(--font-jetbrains-mono)]"
        style={{
          fontSize: "10px",
          fontWeight: 600,
          letterSpacing: "0.22em",
          color: TEXT_DIM,
          textTransform: "uppercase",
        }}
      >
        Evidence consulted
      </div>
      <ul className="flex flex-col" style={{ marginTop: "16px" }}>
        {grouped.map((g, i) => (
          <EvidenceItem key={i} call={g.call} count={g.count} />
        ))}
      </ul>
    </section>
  );
}

function EvidenceItem({
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

  return (
    <li
      style={{
        borderTop: `1px solid ${BORDER_QUIET}`,
        paddingTop: "16px",
        paddingBottom: "16px",
      }}
    >
      <div className="flex items-baseline gap-3 flex-wrap">
        <h3
          className="font-[var(--font-fraunces)]"
          style={{
            fontSize: "16px",
            fontWeight: 400,
            color: errored ? NEGATIVE : TEXT_BRAND,
            letterSpacing: "-0.005em",
          }}
        >
          {humanizeTool(call.tool)}
          {count > 1 ? (
            <span
              className="font-[var(--font-jetbrains-mono)]"
              style={{
                marginLeft: "10px",
                fontSize: "11px",
                color: TEXT_DIM,
                letterSpacing: "0.06em",
              }}
            >
              ×{count}
            </span>
          ) : null}
        </h3>
        <span
          className="font-[var(--font-jetbrains-mono)] tabular-nums ml-auto"
          style={{ fontSize: "10px", color: TEXT_DIM }}
        >
          {call.duration_ms}ms
        </span>
      </div>

      {summary.asked ? (
        <p
          className="font-[var(--font-inter)]"
          style={{
            fontSize: "13px",
            lineHeight: 1.65,
            color: TEXT_MUTED,
            marginTop: "8px",
            maxWidth: "70ch",
          }}
        >
          <span style={{ color: TEXT_DIM }}>Asked for —&nbsp;</span>
          {summary.asked}
        </p>
      ) : null}

      {errored ? (
        <p
          className="font-[var(--font-inter)]"
          style={{
            fontSize: "13px",
            lineHeight: 1.65,
            color: NEGATIVE,
            marginTop: "4px",
            maxWidth: "70ch",
            fontStyle: "italic",
          }}
        >
          <span style={{ color: TEXT_DIM }}>Error —&nbsp;</span>
          {call.error}
        </p>
      ) : summary.found ? (
        <p
          className="font-[var(--font-inter)]"
          style={{
            fontSize: "13px",
            lineHeight: 1.65,
            color: TEXT_BRAND,
            marginTop: "4px",
            maxWidth: "70ch",
          }}
        >
          <span style={{ color: TEXT_DIM }}>Found —&nbsp;</span>
          {summary.found}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => setShowRaw((v) => !v)}
        className="font-[var(--font-jetbrains-mono)] transition-colors"
        style={{
          marginTop: "8px",
          fontSize: "9.5px",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: TEXT_DIM,
        }}
      >
        {showRaw ? "Hide raw payload" : "Inspect raw payload"}
      </button>
      {showRaw ? (
        <div style={{ marginTop: "10px" }} className="flex flex-col gap-2">
          <RawBlock label="Input" value={call.input} />
          <RawBlock
            label={errored ? "Error" : "Output"}
            value={errored ? call.error : call.output}
            tone={errored ? "negative" : "default"}
          />
        </div>
      ) : null}
    </li>
  );
}

function RawBlock({
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
      <div
        className="font-[var(--font-jetbrains-mono)]"
        style={{
          fontSize: "9px",
          fontWeight: 500,
          letterSpacing: "0.18em",
          color: TEXT_DIM,
          textTransform: "uppercase",
          marginBottom: "6px",
        }}
      >
        {label}
      </div>
      <pre
        style={{
          fontSize: "10.5px",
          lineHeight: 1.55,
          maxHeight: "260px",
          overflow: "auto",
          padding: "10px 12px",
          border: `1px solid ${BORDER_QUIET}`,
          background: "rgba(237, 228, 211, 0.02)",
          color: tone === "negative" ? NEGATIVE : TEXT_MUTED,
          fontFamily: "var(--font-jetbrains-mono), monospace",
        }}
      >
        {text}
      </pre>
    </div>
  );
}
