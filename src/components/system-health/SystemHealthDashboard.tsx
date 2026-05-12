"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { fmtRelative } from "@/lib/format";
import { cn } from "@/components/ui/cn";
import { FrameworkSwitchPanel } from "./FrameworkSwitchPanel";

interface AlertRow {
  id: number;
  raised_at: number;
  kind: string;
  severity: "warn" | "error";
  message: string;
  resolved_at: number | null;
}

interface Snapshot {
  last_classification_run: number | null;
  last_signal_gen_run: number | null;
  last_outcome_resolution_run: number | null;
  stuck_outcomes: number;
  recent_gate_refusals: Array<{ rule: string; count: number }>;
  recent_classifier_errors: number;
  db_size_bytes: number;
  read_only: boolean;
  dropped_headlines_24h: number;
  signals_created_24h: number;
  suppressed_signals_24h: number;
  supersessions_24h: number;
  skipped_pre_classify_24h: number;
  generated_at: number;
}

interface Payload {
  snapshot: Snapshot;
  open_alerts: AlertRow[];
  recent_alerts: AlertRow[];
}

export function SystemHealthDashboard() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/data/system-health");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (loading && !data) {
    return <div className="text-sm text-fg-dim">Loading…</div>;
  }
  if (!data) {
    return <div className="text-sm text-negative">Error: {error}</div>;
  }

  const s = data.snapshot;
  return (
    <div className="flex flex-col gap-4">
      {/* Read-only banner if active */}
      {s.read_only ? (
        <div className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-sm text-warning">
          READ_ONLY mode is active — signal generation is disabled.
          Outcome resolution and dashboards still run.
        </div>
      ) : null}

      {/* Open alerts strip */}
      {data.open_alerts.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Open alerts</CardTitle>
            <span className="text-xs text-fg-muted">
              {data.open_alerts.length} unresolved
            </span>
          </CardHeader>
          <CardBody className="!p-0">
            <ul className="divide-y divide-line">
              {data.open_alerts.map((a) => (
                <li
                  key={a.id}
                  className="flex items-baseline gap-3 px-4 py-2 text-xs"
                >
                  <Badge tone={a.severity === "error" ? "negative" : "warning"}>
                    {a.severity.toUpperCase()}
                  </Badge>
                  <span className="font-mono text-fg">{a.kind}</span>
                  <span className="text-fg-muted">{a.message}</span>
                  <span className="ml-auto text-fg-dim">
                    {fmtRelative(a.raised_at)}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {/* Top stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Last classification"
          value={
            s.last_classification_run
              ? fmtRelative(s.last_classification_run)
              : "—"
          }
          tone={
            s.last_classification_run &&
            Date.now() - s.last_classification_run < 30 * 60 * 1000
              ? "positive"
              : "warning"
          }
        />
        <StatTile
          label="Last signal-gen"
          value={
            s.last_signal_gen_run ? fmtRelative(s.last_signal_gen_run) : "—"
          }
          tone={
            s.last_signal_gen_run &&
            Date.now() - s.last_signal_gen_run < 60 * 60 * 1000
              ? "positive"
              : "warning"
          }
        />
        <StatTile
          label="Last resolution"
          value={
            s.last_outcome_resolution_run
              ? fmtRelative(s.last_outcome_resolution_run)
              : "—"
          }
          tone={
            s.last_outcome_resolution_run &&
            Date.now() - s.last_outcome_resolution_run < 30 * 60 * 1000
              ? "positive"
              : "warning"
          }
        />
        <StatTile
          label="Stuck outcomes"
          value={String(s.stuck_outcomes)}
          tone={s.stuck_outcomes > 10 ? "negative" : s.stuck_outcomes > 0 ? "warning" : "positive"}
          sub="pending past expiry"
        />
        <StatTile
          label="Classifier errors (1h)"
          value={String(s.recent_classifier_errors)}
          tone={s.recent_classifier_errors > 0 ? "warning" : "positive"}
        />
        <StatTile
          label="DB size"
          value={fmtBytes(s.db_size_bytes)}
          sub="sqlite file"
        />
        <StatTile
          label="Mode"
          value={s.read_only ? "READ_ONLY" : "live"}
          tone={s.read_only ? "warning" : "positive"}
        />
        <StatTile
          label="Headlines dropped (24h)"
          value={String(s.dropped_headlines_24h)}
          sub={
            s.signals_created_24h + s.dropped_headlines_24h > 0
              ? `${s.signals_created_24h} created, ${s.dropped_headlines_24h} below significance gate`
              : "no headlines ingested in window"
          }
          tone={
            s.dropped_headlines_24h > s.signals_created_24h * 3
              ? "warning"
              : "default"
          }
        />
        <StatTile
          label="Suppressions (24h)"
          value={String(s.suppressed_signals_24h)}
          sub="opposite-direction conflicts resolved at emission"
          tone="default"
        />
        <StatTile
          label="Supersessions (24h)"
          value={String(s.supersessions_24h)}
          sub="standing signals retired by ≥1.5× significance"
          tone="default"
        />
        <StatTile
          label="Pre-classify drops (24h)"
          value={String(s.skipped_pre_classify_24h)}
          sub="corpus gate skipped — Claude tokens saved"
          tone="default"
        />
      </div>

      {/* Gate refusals */}
      <Card>
        <CardHeader>
          <CardTitle>Recent gate refusals · last 24h</CardTitle>
          <span className="text-xs text-fg-muted">
            grouped by rule · spikes here are upstream-stage hints
          </span>
        </CardHeader>
        <CardBody className="!p-0">
          {s.recent_gate_refusals.length === 0 ? (
            <div className="px-4 py-4 text-xs text-fg-dim">
              No gate refusals in the last 24h.
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {s.recent_gate_refusals.map((r) => (
                <li
                  key={r.rule}
                  className="flex items-center justify-between px-4 py-2 text-xs"
                >
                  <code className="rounded bg-surface-2 px-1.5 py-0.5 text-fg">
                    {r.rule}
                  </code>
                  <span className="tabular text-fg-muted">{r.count}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* Recent alerts log (resolved + open) */}
      <Card>
        <CardHeader>
          <CardTitle>Alert log · last 20</CardTitle>
        </CardHeader>
        <CardBody className="!p-0">
          {data.recent_alerts.length === 0 ? (
            <div className="px-4 py-4 text-xs text-fg-dim">
              No alerts on record.
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {data.recent_alerts.map((a) => (
                <li
                  key={a.id}
                  className="flex items-baseline gap-3 px-4 py-2 text-xs"
                >
                  <Badge tone={a.severity === "error" ? "negative" : "warning"}>
                    {a.severity.toUpperCase()}
                  </Badge>
                  <span className="font-mono text-fg-muted">{a.kind}</span>
                  <span className="text-fg-muted">{a.message}</span>
                  <span
                    className={cn(
                      "ml-auto text-fg-dim",
                      a.resolved_at != null ? "" : "text-warning",
                    )}
                  >
                    {a.resolved_at != null
                      ? `resolved ${fmtRelative(a.resolved_at)}`
                      : `open ${fmtRelative(a.raised_at)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* Framework switch history (Part 3 of v2.1 attribution / I-38) */}
      <FrameworkSwitchPanel />
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "positive" | "negative" | "warning" | "default";
}) {
  const v =
    tone === "positive"
      ? "text-positive"
      : tone === "negative"
        ? "text-negative"
        : tone === "warning"
          ? "text-warning"
          : "text-fg";
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-fg-dim">
        {label}
      </div>
      <div className={cn("tabular text-base font-semibold", v)}>{value}</div>
      {sub ? <div className="text-[10px] text-fg-dim">{sub}</div> : null}
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
