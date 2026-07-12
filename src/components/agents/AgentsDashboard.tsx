"use client";

/**
 * /agents — operational dashboard for the Wave 2 agentic layer.
 *
 * Shows: recent agent runs, 24h totals, per-agent breakdown, and tool
 * call frequency. Every trace row links to the audit page so users can
 * drill into any individual agent decision.
 */

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Num } from "@/components/ui/Num";
import { DataTable } from "@/components/ui/DataTable";
import { Timestamp } from "@/components/ui/Timestamp";
import { BuildathonModeCard } from "./BuildathonModeCard";

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

interface AgentTrace {
  id: string;
  agent_name: string;
  event_id: string | null;
  signal_id: string | null;
  started_at: number;
  finished_at: number | null;
  status: "running" | "ok" | "error";
  rounds: number;
  steps: Array<{ type: string }>;
  tokens_input: number;
  tokens_output: number;
  tokens_cached: number;
  cost_usd: number;
  model: string | null;
  error: string | null;
}

interface Resp {
  recent: AgentTrace[];
  totals_24h: {
    runs: number;
    tokens_input: number;
    tokens_output: number;
    tokens_cached: number;
    cost_usd: number;
  };
  per_agent_24h: AgentSummary[];
  tool_freq_24h: ToolFreq[];
}

const TOOL_LABEL: Record<string, string> = {
  search_outlet_coverage: "Search outlet coverage",
  query_asset_history: "Query asset history",
  query_event_type_stats: "Query event-type stats",
  fetch_full_article: "Fetch full article",
  query_base_rate: "Query base rate",
  query_price_around_catalyst: "Query price tape",
  submit_classification: "Submit classification",
};

export function AgentsDashboard() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/data/agents")
      .then((r) => r.json())
      .then((j) => setData(j as Resp))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-sm text-fg-dim">Loading…</div>;
  if (!data) return <div className="text-sm text-negative">No data.</div>;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold text-fg">Agent Activity</h1>
        <p className="text-sm text-fg-muted">
          Every Wave 2 agent run lives here. Each row is a multi-step,
          tool-using decision — click through for the full transcript.
        </p>
      </header>

      <BuildathonModeCard variant="agents" />

      {/* 24h overview */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat
          label="Runs (24h)"
          value={<Num value={data.totals_24h.runs} tier="lead" />}
        />
        <Stat
          label="Successful"
          value={
            <Num
              value={data.per_agent_24h.reduce((acc, a) => acc + a.ok, 0)}
              tier="secondary"
            />
          }
        />
        <Stat
          label="Errored"
          value={
            <Num
              value={data.per_agent_24h.reduce((acc, a) => acc + a.errored, 0)}
              tier="secondary"
              tone="negative"
            />
          }
        />
      </div>

      {/* Per-agent breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>By agent (24h)</CardTitle>
        </CardHeader>
        <CardBody className="!p-0">
          {data.per_agent_24h.length === 0 ? (
            <div className="p-4 text-sm text-fg-muted">
              No agent runs in the last 24 hours yet.
            </div>
          ) : (
            <DataTable<AgentSummary>
              rows={data.per_agent_24h}
              getKey={(a) => a.agent_name}
              minWidth={420}
              columns={[
                {
                  key: "agent",
                  header: "Agent",
                  role: "identifier",
                  render: (a) => a.agent_name,
                },
                {
                  key: "runs",
                  header: "Runs",
                  role: "magnitude",
                  num: (a) => a.runs,
                },
                {
                  key: "errored",
                  header: "Errors",
                  role: "context",
                  num: (a) => a.errored,
                  tone: "negative",
                },
                {
                  key: "cost",
                  header: "Cost",
                  role: "context",
                  num: (a) => a.total_cost_usd,
                  unit: "$",
                  dp: 2,
                },
              ]}
            />
          )}
        </CardBody>
      </Card>

      {/* Tool frequency */}
      <Card>
        <CardHeader>
          <CardTitle>Tool use (24h)</CardTitle>
          <span className="text-[11px] text-fg-dim">
            Which tools the agents lean on most
          </span>
        </CardHeader>
        <CardBody>
          {data.tool_freq_24h.length === 0 ? (
            <div className="text-sm text-fg-muted">
              No tool calls in the last 24 hours.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {data.tool_freq_24h.map((t) => {
                const max = data.tool_freq_24h[0]?.calls ?? 1;
                const pct = (t.calls / max) * 100;
                return (
                  <div key={t.tool} className="flex flex-col gap-0.5">
                    <div className="flex justify-between text-xs">
                      <span className="text-fg-muted">
                        {TOOL_LABEL[t.tool] ?? t.tool}
                      </span>
                      <Num value={t.calls} tier="context" />
                    </div>
                    <div className="h-1.5 overflow-hidden rounded bg-surface-2">
                      <div
                        className="h-full bg-accent/60"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Recent traces */}
      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
          <span className="text-[11px] text-fg-dim">
            Click through to the audit page for the full trace
          </span>
        </CardHeader>
        <CardBody className="!p-0">
          {data.recent.length === 0 ? (
            <div className="p-4 text-sm text-fg-muted">
              No agent runs yet. Trigger one with POST /api/agent/research.
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {data.recent.map((t) => {
                const target = t.signal_id
                  ? `/signal/${t.signal_id}`
                  : t.event_id
                    ? null
                    : null;
                const durationSec =
                  t.finished_at != null
                    ? (t.finished_at - t.started_at) / 1000
                    : null;
                const toolCalls = t.steps.filter(
                  (s) => s.type === "tool_call",
                ).length;
                const Row = (
                  <div className="grid grid-cols-[80px_100px_1fr_80px_120px] items-center gap-3 px-4 py-2 text-xs">
                    <Badge tone={t.status === "ok" ? "positive" : "negative"}>
                      {t.status}
                    </Badge>
                    <span className="font-mono text-fg">{t.agent_name}</span>
                    <span className="truncate font-mono text-fg-dim" title={t.id}>
                      {t.event_id ? `event ${shortId(t.event_id)}` : t.id.slice(0, 8)}
                    </span>
                    <span className="text-right text-fg-muted">
                      <Num value={toolCalls} tier="context" /> call
                      {toolCalls === 1 ? "" : "s"}
                    </span>
                    <span className="tabular text-right text-fg-dim">
                      <Timestamp ms={t.started_at} mode="relative" /> ·{" "}
                      {durationSec != null ? (
                        <>
                          <Num value={durationSec} dp={1} tier="context" />s
                        </>
                      ) : (
                        "—"
                      )}
                    </span>
                  </div>
                );
                return (
                  <li key={t.id}>
                    {target ? (
                      <Link
                        href={target}
                        className="block transition-colors hover:bg-surface-2"
                      >
                        {Row}
                      </Link>
                    ) : (
                      Row
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Card>
      <CardBody>
        <div className="text-[10px] uppercase tracking-wider text-fg-dim">
          {label}
        </div>
        <div className="mt-1">{value}</div>
      </CardBody>
    </Card>
  );
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-3)}` : id;
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}
