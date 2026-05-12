"use client";

/**
 * Stress Tests panel — Part 1.
 *
 * Three side-by-side equity curves of historical replays + a summary
 * table of return / drawdown / Sharpe / alpha-vs-BTC.
 *
 * Replays use zero-news mode; the panel surfaces this caveat
 * prominently so users don't read the numbers as a forecast of live
 * strategy performance.
 */

import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";

interface ReplayPayload {
  start_date: string;
  end_date: string;
  label: string;
  hypothesis: string;
  notes: string | null;
  sample_days: number;
  rebalance_count: number;
  return_pct: number;
  max_drawdown_pct: number;
  sharpe: number | null;
  alpha_vs_btc_pct: number | null;
  btc_metrics: { return_pct: number; max_drawdown_pct: number };
  curve: Array<{ date: string; alphacore: number; btc: number | null }>;
}

interface ApiResponse {
  ok: boolean;
  note?: string;
  error?: string;
  coverage_days?: number;
  replays: ReplayPayload[];
}

export function StressTestsPanel() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/data/alphaindex/stress-tests");
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

  if (loading) return <div className="text-sm text-fg-dim">Running historical replays…</div>;
  if (error || !data?.ok) {
    return (
      <Card>
        <CardBody>
          <div className="text-sm text-negative">
            Stress tests unavailable: {data?.error ?? error}
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Caveat banner — zero-news mode */}
      <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
        <strong>Zero-news mode:</strong> Replays use historical momentum
        data with news signals = 0. Live strategy includes news-signal
        boosts which are NOT reflected here. These tests measure the
        framework, not the production strategy.
      </div>

      {/* Three equity curves side by side */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {data.replays.map((r) => (
          <Card key={r.start_date + "-" + r.end_date}>
            <CardHeader>
              <CardTitle>
                <span className="text-sm font-medium">{r.label}</span>
              </CardTitle>
              <span className="text-[11px] text-fg-muted">
                {r.start_date} → {r.end_date}
              </span>
            </CardHeader>
            <CardBody>
              <p className="mb-2 text-[11px] text-fg-muted">{r.hypothesis}</p>
              <div className="h-44 w-full">
                <ResponsiveContainer>
                  <LineChart
                    data={r.curve}
                    margin={{ top: 4, right: 8, bottom: 4, left: -16 }}
                  >
                    <CartesianGrid stroke="#1a1f2a" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 9, fill: "#7a8290" }}
                      tickFormatter={(d: string) => d.slice(5)}
                      stroke="#2a3340"
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tick={{ fontSize: 9, fill: "#7a8290" }}
                      stroke="#2a3340"
                      domain={["dataMin - 2", "dataMax + 2"]}
                      tickFormatter={(v: number) => `${(v - 100).toFixed(0)}%`}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "#0f1218",
                        border: "1px solid #2a3340",
                        borderRadius: 6,
                        fontSize: 11,
                        color: "#e6e9ef",
                      }}
                      formatter={(value: unknown, name: unknown) => {
                        const v = typeof value === "number" ? value : Number(value);
                        if (!Number.isFinite(v)) return ["—", String(name)];
                        return [`${(v - 100).toFixed(2)}%`, String(name)];
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="alphacore"
                      name="AlphaCore"
                      stroke="#ff7a45"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="btc"
                      name="BTC"
                      stroke="#f59e0b"
                      strokeWidth={1.5}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1 text-[10px]">
                <ReplayStat label="AlphaCore ret" value={r.return_pct} kind="pct" />
                <ReplayStat label="BTC ret" value={r.btc_metrics.return_pct} kind="pct" />
                <ReplayStat
                  label="AlphaCore DD"
                  value={r.max_drawdown_pct}
                  kind="pct_neg"
                />
                <ReplayStat
                  label="BTC DD"
                  value={r.btc_metrics.max_drawdown_pct}
                  kind="pct_neg"
                />
                <ReplayStat label="α vs BTC" value={r.alpha_vs_btc_pct} kind="pct" />
                <ReplayStat label="Sharpe" value={r.sharpe} kind="raw" />
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      {/* Summary table */}
      <Card>
        <CardHeader>
          <CardTitle>Replay summary</CardTitle>
          <span className="text-xs text-fg-muted">
            {data.note}
          </span>
        </CardHeader>
        <CardBody className="!p-0">
          <table className="w-full text-xs">
            <thead className="border-b border-line bg-surface-2">
              <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                <th className="px-3 py-2 text-left">Period</th>
                <th className="px-3 py-2 text-right">AlphaCore</th>
                <th className="px-3 py-2 text-right">BTC</th>
                <th className="px-3 py-2 text-right">α vs BTC</th>
                <th className="px-3 py-2 text-right">AlphaCore DD</th>
                <th className="px-3 py-2 text-right">BTC DD</th>
                <th className="px-3 py-2 text-right">Sharpe</th>
                <th className="px-3 py-2 text-right">Rebalances</th>
                <th className="px-3 py-2 text-right">Days</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.replays.map((r) => (
                <tr
                  key={r.start_date + "-" + r.end_date}
                  className="transition-colors hover:bg-surface-2"
                >
                  <td className="px-3 py-2 text-fg">
                    <div className="font-mono text-[11px]">{r.label}</div>
                    <div className="text-[10px] text-fg-dim">
                      {r.start_date} → {r.end_date}
                    </div>
                  </td>
                  <td className={cn("tabular px-3 py-2 text-right", r.return_pct > 0 ? "text-positive" : "text-negative")}>
                    {fmtPct(r.return_pct)}
                  </td>
                  <td className={cn("tabular px-3 py-2 text-right", r.btc_metrics.return_pct > 0 ? "text-positive" : "text-negative")}>
                    {fmtPct(r.btc_metrics.return_pct)}
                  </td>
                  <td
                    className={cn(
                      "tabular px-3 py-2 text-right",
                      (r.alpha_vs_btc_pct ?? 0) > 0
                        ? "text-positive"
                        : (r.alpha_vs_btc_pct ?? 0) < 0
                          ? "text-negative"
                          : "",
                    )}
                  >
                    {r.alpha_vs_btc_pct != null ? fmtPct(r.alpha_vs_btc_pct) : "—"}
                  </td>
                  <td className="tabular px-3 py-2 text-right text-negative">
                    {r.max_drawdown_pct.toFixed(1)}%
                  </td>
                  <td className="tabular px-3 py-2 text-right text-negative">
                    {r.btc_metrics.max_drawdown_pct.toFixed(1)}%
                  </td>
                  <td className="tabular px-3 py-2 text-right text-fg">
                    {r.sharpe != null ? r.sharpe.toFixed(2) : "—"}
                  </td>
                  <td className="tabular px-3 py-2 text-right text-fg-muted">
                    {r.rebalance_count}
                  </td>
                  <td className="tabular px-3 py-2 text-right text-fg-dim">
                    {r.sample_days}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>
    </div>
  );
}

function ReplayStat({
  label,
  value,
  kind,
}: {
  label: string;
  value: number | null;
  kind: "pct" | "pct_neg" | "raw";
}) {
  const display =
    value == null
      ? "—"
      : kind === "raw"
        ? value.toFixed(2)
        : `${kind === "pct" && value > 0 ? "+" : ""}${value.toFixed(1)}%`;
  const tone =
    value == null
      ? "text-fg-dim"
      : kind === "pct"
        ? value > 0
          ? "text-positive"
          : value < 0
            ? "text-negative"
            : "text-fg"
        : kind === "pct_neg"
          ? "text-negative"
          : "text-fg";
  return (
    <div className="rounded border border-line bg-surface-2 px-2 py-1">
      <div className="text-[9px] uppercase tracking-wider text-fg-dim">{label}</div>
      <div className={cn("tabular text-[11px] font-semibold", tone)}>{display}</div>
    </div>
  );
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}
