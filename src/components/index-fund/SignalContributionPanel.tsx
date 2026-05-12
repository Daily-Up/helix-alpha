"use client";

/**
 * Signal contribution panel — Part 3.
 *
 * Top-level number: "signals added/subtracted $X across the last N
 * resolved rebalances." Below it, a per-rebalance bar chart of total
 * P&L attributed to the news-signal layer, plus a table of the most
 * recent rebalances showing weight deltas and realized P&L per asset.
 *
 * When a row's `sanity_ok=false` we surface a short warning instead of
 * the numbers — see the file-level note in signal-attribution.ts for
 * why we'd rather say nothing than display garbage.
 */

import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { fmtUsd } from "@/lib/format";
import { cn } from "@/components/ui/cn";

interface AttribRow {
  id: string;
  rebalance_id: string;
  asof_ms: number;
  pre_nav_usd: number;
  weight_deltas_bps: Record<string, number>;
  realized_pnl_usd: Record<string, number> | null;
  total_pnl_usd: number | null;
  sanity_ok: boolean;
  sanity_note: string | null;
  resolved_at: number | null;
}

interface ApiResponse {
  ok: boolean;
  total_pnl_usd: number;
  resolved_count: number;
  pending_count: number;
  symbols?: Record<string, { symbol: string; name: string }>;
  rebalances: AttribRow[];
  error?: string;
}

export function SignalContributionPanel() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          "/api/data/alphaindex/signal-attribution?id=alphacore",
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as ApiResponse;
        if (!cancelled) setData(j);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <Card>
        <CardBody>
          <div className="text-sm text-fg-dim">Loading attribution…</div>
        </CardBody>
      </Card>
    );
  }
  if (error || !data?.ok) {
    return (
      <Card>
        <CardBody>
          <div className="text-sm text-negative">
            Attribution unavailable: {data?.error ?? error}
          </div>
        </CardBody>
      </Card>
    );
  }

  // Empty-state — no rebalances have happened yet so there's nothing to attribute.
  if (data.rebalances.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Signal contribution</CardTitle>
          <span className="text-xs text-fg-muted">
            news-signal P&amp;L vs. momentum-only counterfactual
          </span>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-fg-dim">
            No attribution data yet — runs after the first rebalance and
            resolves at the second.
          </p>
        </CardBody>
      </Card>
    );
  }

  // Bar chart data: one bar per resolved rebalance, oldest → newest.
  const chartRows = [...data.rebalances]
    .reverse()
    .filter((r) => r.total_pnl_usd != null && r.sanity_ok)
    .map((r) => ({
      date: new Date(r.asof_ms).toISOString().slice(5, 10),
      pnl: r.total_pnl_usd ?? 0,
    }));

  const totalToneClass =
    data.total_pnl_usd > 0
      ? "text-positive"
      : data.total_pnl_usd < 0
        ? "text-negative"
        : "text-fg";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Signal contribution</CardTitle>
        <span className="text-xs text-fg-muted">
          news-signal P&amp;L vs. momentum-only counterfactual ·{" "}
          {data.resolved_count} resolved · {data.pending_count} pending
        </span>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        {/* Top-line summary */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-fg-dim">
            cumulative signal P&amp;L
          </span>
          <span className={cn("tabular text-2xl font-semibold", totalToneClass)}>
            {fmtUsd(data.total_pnl_usd)}
          </span>
          <span className="text-[11px] text-fg-dim">
            sum across {data.resolved_count} resolved rebalance
            {data.resolved_count !== 1 ? "s" : ""}. Positive = news signals
            added value over plain momentum.
          </span>
        </div>

        {/* Bar chart per rebalance */}
        {chartRows.length > 0 ? (
          <div className="h-44 w-full">
            <ResponsiveContainer>
              <BarChart
                data={chartRows}
                margin={{ top: 4, right: 8, bottom: 4, left: -8 }}
              >
                <CartesianGrid stroke="#1a1f2a" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "#7a8290" }}
                  stroke="#2a3340"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "#7a8290" }}
                  stroke="#2a3340"
                  tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                />
                <Tooltip
                  contentStyle={{
                    background: "#0f1218",
                    border: "1px solid #2a3340",
                    borderRadius: 6,
                    fontSize: 11,
                    color: "#e6e9ef",
                  }}
                  formatter={(value: unknown) => {
                    const v = typeof value === "number" ? value : Number(value);
                    return [`$${v.toFixed(2)}`, "Signal P&L"];
                  }}
                />
                <Bar dataKey="pnl">
                  {chartRows.map((row, idx) => (
                    <Cell
                      key={idx}
                      fill={row.pnl >= 0 ? "#22c55e" : "#ef4444"}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : null}

        {/* Per-rebalance table */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-line bg-surface-2">
              <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                <th className="px-3 py-2 text-left">When</th>
                <th className="px-3 py-2 text-right">Signal P&amp;L</th>
                <th className="px-3 py-2 text-left">Top tilts (Δ bps)</th>
                <th className="px-3 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.rebalances.slice(0, 12).map((r) => {
                const date = new Date(r.asof_ms).toISOString().slice(0, 10);
                return (
                  <tr
                    key={r.id}
                    className="transition-colors hover:bg-surface-2"
                  >
                    <td className="px-3 py-2 text-fg-muted">{date}</td>
                    <td
                      className={cn(
                        "tabular px-3 py-2 text-right",
                        r.total_pnl_usd != null && r.sanity_ok
                          ? r.total_pnl_usd > 0
                            ? "text-positive"
                            : r.total_pnl_usd < 0
                              ? "text-negative"
                              : "text-fg"
                          : "text-fg-dim",
                      )}
                    >
                      {r.sanity_ok && r.total_pnl_usd != null
                        ? fmtUsd(r.total_pnl_usd)
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-fg-muted">
                      {r.sanity_ok ? (
                        <TopTilts
                          deltas={r.weight_deltas_bps}
                          symbols={data.symbols ?? {}}
                        />
                      ) : (
                        <span className="text-fg-dim">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[10px]">
                      {!r.sanity_ok ? (
                        <span className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-warning">
                          {r.sanity_note ?? "sanity failed"}
                        </span>
                      ) : r.resolved_at != null ? (
                        <span className="rounded border border-line bg-surface-2 px-1.5 py-0.5 text-fg-dim">
                          resolved
                        </span>
                      ) : (
                        <span className="rounded border border-info/40 bg-info/10 px-1.5 py-0.5 text-info">
                          pending
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  );
}

/** Render the 3 largest absolute weight deltas as compact chips. */
function TopTilts({
  deltas,
  symbols,
}: {
  deltas: Record<string, number>;
  symbols: Record<string, { symbol: string; name: string }>;
}) {
  const entries = Object.entries(deltas)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3);
  if (entries.length === 0) {
    return <span className="text-fg-dim">no tilts</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([id, bps]) => (
        <span
          key={id}
          className={cn(
            "rounded border px-1.5 py-0.5 text-[10px]",
            bps > 0
              ? "border-positive/30 bg-positive/10 text-positive"
              : "border-negative/30 bg-negative/10 text-negative",
          )}
        >
          {symbols[id]?.symbol ?? id} {bps > 0 ? "+" : ""}
          {bps}bp
        </span>
      ))}
    </div>
  );
}
