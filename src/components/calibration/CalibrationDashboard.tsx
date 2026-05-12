"use client";

/**
 * /calibration — five panels rendered from /api/data/calibration.
 *
 * Each panel has its own component so they can render independently.
 * The API call is one round-trip — small enough that we don't bother
 * with per-panel pagination.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import Link from "next/link";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { HeroStat, SubStat } from "@/components/ui/HeroStat";
import { Badge } from "@/components/ui/Badge";
import { PanelSkeleton, ChartSkeleton } from "@/components/ui/Skeleton";
import { useBulkMountReveal } from "@/hooks/useMountReveal";
import { fmtRelative, fmtUsd } from "@/lib/format";
import { cn } from "@/components/ui/cn";

interface CalibrationPayload {
  window_days: number;
  generated_at: number;
  by_tier: Array<{
    tier: "auto" | "review" | "info";
    sample: number;
    target_hit: number;
    stop_hit: number;
    flat: number;
    dismissed: number;
    resolved_sample: number;
    hit_rate: number | null;
    mean_realized_pct: number | null;
  }>;
  by_subtype: Array<{
    catalyst_subtype: string;
    sample: number;
    target_hit: number;
    stop_hit: number;
    flat: number;
    hit_rate: number | null;
    mean_realized_pct: number | null;
    median_realized_pct: number | null;
    total_pnl_usd: number;
  }>;
  calibration_curve: Array<{
    bin_start: number;
    bin_end: number;
    sample: number;
    mean_conviction: number;
    hit_rate: number | null;
  }>;
  pnl_grid: Array<{
    catalyst_subtype: string;
    asset_class: string;
    sample: number;
    mean_realized_pct: number | null;
    total_pnl_usd: number;
  }>;
  extremes: {
    winners: ExtremeRow[];
    losers: ExtremeRow[];
  };
  latency_ms: number;
  framework_version?: string | null;
  framework_summary?: {
    v1: FrameworkEntry;
    v2: FrameworkEntry;
    delta: {
      hit_rate: number;
      total_pnl_usd: number;
      mean_realized_pct: number;
      sample: number;
    };
  };
}

interface FrameworkEntry {
  sample: number;
  target_hit: number;
  stop_hit: number;
  flat: number;
  hit_rate: number | null;
  total_pnl_usd: number;
  mean_realized_pct: number | null;
}

interface ExtremeRow {
  signal_id: string;
  asset_id: string;
  direction: "long" | "short";
  tier: "auto" | "review" | "info";
  catalyst_subtype: string;
  asset_class: string;
  conviction: number;
  realized_pct: number | null;
  realized_pnl_usd: number | null;
  outcome: string;
  generated_at: number;
}

const WINDOW_OPTIONS: Array<{ label: string; days: number }> = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "All", days: 365 },
];

type FrameworkFilter = "all" | "v1" | "v2" | "compare";

export function CalibrationDashboard() {
  const [data, setData] = useState<CalibrationPayload | null>(null);
  const [windowDays, setWindowDays] = useState(30);
  // Honor ?compare=1 link so the AlphaIndex live tab can deep-link
  // straight into the side-by-side framework comparison view.
  const initialFw: FrameworkFilter =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("compare") === "1"
      ? "compare"
      : "all";
  const [framework, setFramework] = useState<FrameworkFilter>(initialFw);
  // Phase E — toggle: include superseded signals (treated as flat at the
  // supersession timestamp)? Default ON to preserve the calibration sample
  // size. OFF excludes them entirely (useful when measuring an alternate
  // framework's resolution behavior).
  const [includeSuperseded, setIncludeSuperseded] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setError(null);
    try {
      // For "all" + "compare" the route returns the unfiltered aggregate
      // along with `framework_summary` containing per-framework deltas
      // (Compare uses the same payload, just renders differently).
      const fwQ =
        framework === "v1" || framework === "v2"
          ? `&framework=${framework}`
          : "";
      const supQ = includeSuperseded ? "" : "&exclude_superseded=1";
      const r = await fetch(
        `/api/data/calibration?window=${windowDays}${fwQ}${supQ}`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [windowDays, framework, includeSuperseded]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  const revealRef = useBulkMountReveal();

  if (loading && !data) {
    return (
      <div className="flex flex-col gap-4">
        <ChartSkeleton height="h-48" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ChartSkeleton height="h-64" />
          <ChartSkeleton height="h-64" />
        </div>
        <PanelSkeleton height="h-48" />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="text-sm text-negative">
        Error loading calibration: {error}
      </div>
    );
  }

  // Aggregate hit-rate across all tiers — the page's headline number.
  const totals = data.by_tier.reduce(
    (acc, t) => {
      acc.target += t.target_hit;
      acc.resolved += t.resolved_sample;
      acc.realized += (t.mean_realized_pct ?? 0) * t.resolved_sample;
      return acc;
    },
    { target: 0, resolved: 0, realized: 0 },
  );
  const overallHitRate = totals.resolved > 0 ? totals.target / totals.resolved : null;
  const overallRealizedAvg =
    totals.resolved > 0 ? totals.realized / totals.resolved : null;

  return (
    <div ref={revealRef} className="dash-crossfade-enter flex flex-col gap-4">
      {/* Headline: overall hit rate across the window. */}
      <div className="mt-2 flex flex-col gap-6">
        <HeroStat
          label={`Overall hit rate · ${windowDays}d`}
          value={
            overallHitRate != null
              ? `${(overallHitRate * 100).toFixed(0)}%`
              : "—"
          }
          change={
            overallRealizedAvg != null
              ? `Avg realised ${overallRealizedAvg >= 0 ? "+" : ""}${overallRealizedAvg.toFixed(2)}%`
              : undefined
          }
          changeTone={
            (overallRealizedAvg ?? 0) > 0
              ? "positive"
              : (overallRealizedAvg ?? 0) < 0
                ? "negative"
                : "neutral"
          }
          sub={`${totals.target}/${totals.resolved} resolved · ${data.by_subtype.length} subtypes`}
        />
        <div className="grid grid-cols-3 gap-x-10 md:max-w-[640px]">
          {data.by_tier.map((t) => (
            <SubStat
              key={t.tier}
              label={t.tier.toUpperCase()}
              value={
                t.hit_rate != null ? `${(t.hit_rate * 100).toFixed(0)}%` : "—"
              }
              sub={`${t.target_hit}/${t.resolved_sample}`}
              tone={
                (t.hit_rate ?? 0.5) >= 0.55
                  ? "positive"
                  : (t.hit_rate ?? 0.5) <= 0.45
                    ? "negative"
                    : "neutral"
              }
            />
          ))}
        </div>
      </div>

      {/* Window toggle */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-fg-dim">window:</span>
        {WINDOW_OPTIONS.map((o) => (
          <button
            key={o.days}
            onClick={() => setWindowDays(o.days)}
            className={cn(
              "dash-tab-trigger rounded border px-2 py-0.5 transition-colors",
              windowDays === o.days
                ? "dash-tab-active border-accent bg-accent/15 text-accent-2"
                : "border-line text-fg-muted hover:border-line-2",
            )}
          >
            {o.label}
          </button>
        ))}
        <span className="ml-auto text-fg-dim">
          last refreshed {fmtRelative(data.generated_at)} · {data.latency_ms}ms
        </span>
        <button
          onClick={() => fetchData()}
          className="rounded border border-line px-2 py-0.5 text-fg-muted hover:border-line-2"
        >
          ↻ refresh
        </button>
      </div>

      {/* Framework toggle (Part 1 of v2.1 attribution) */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-fg-dim">framework:</span>
        {(["all", "v1", "v2", "compare"] as FrameworkFilter[]).map((opt) => (
          <button
            key={opt}
            onClick={() => setFramework(opt)}
            className={cn(
              "rounded border px-2 py-0.5 transition-colors",
              framework === opt
                ? "border-accent bg-accent/15 text-accent-2"
                : "border-line text-fg-muted hover:border-line-2",
            )}
          >
            {opt === "all"
              ? "All"
              : opt === "v1"
                ? "v1"
                : opt === "v2"
                  ? "v2.1"
                  : "Compare"}
          </button>
        ))}
        {framework !== "all" && framework !== "compare" ? (
          <span className="text-fg-dim">
            · panels filtered to <strong className="text-fg">{framework === "v1" ? "v1" : "v2.1"}</strong> outcomes only
          </span>
        ) : null}
        <span className="ml-4 inline-flex items-center gap-2">
          <label
            className="cursor-pointer text-fg-muted inline-flex items-center gap-1"
            title="Include superseded signals as 'flat' outcomes (Phase E). When off, they're excluded from sample stats."
          >
            <input
              type="checkbox"
              checked={includeSuperseded}
              onChange={(e) => setIncludeSuperseded(e.target.checked)}
              className="cursor-pointer"
            />
            include superseded
          </label>
        </span>
      </div>

      {/* Compare view: side-by-side framework summary card with deltas */}
      {framework === "compare" && data.framework_summary ? (
        <FrameworkComparisonCard summary={data.framework_summary} />
      ) : null}

      {/* Panel 1 + Panel 3 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PanelHitRateByTier rows={data.by_tier} />
        <PanelCalibrationCurve bins={data.calibration_curve} />
      </div>

      {/* Panel 2 */}
      <div className="">
        <PanelHitRateBySubtype rows={data.by_subtype} />
      </div>

      {/* Panel 4 + Panel 5 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <PanelPnlGrid rows={data.pnl_grid} />
        </div>
        <PanelExtremes
          winners={data.extremes.winners}
          losers={data.extremes.losers}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Framework comparison (Part 1 of v2.1 attribution) — Compare view only
// ─────────────────────────────────────────────────────────────────────

function FrameworkComparisonCard({
  summary,
}: {
  summary: NonNullable<CalibrationPayload["framework_summary"]>;
}) {
  // Graceful empty state — Part 3 of v2.1 attribution gap-closing.
  // If either framework has zero outcomes the data cells render as
  // "—" with explanatory copy directly under the table. The Compare
  // panel structure stays identical so the layout doesn't reflow when
  // outcomes start landing.
  const v1Empty = summary.v1.sample === 0;
  const v2Empty = summary.v2.sample === 0;
  const fmtRate = (r: number | null) =>
    r == null ? "—" : `${(r * 100).toFixed(1)}%`;
  const fmtDelta = (d: number, kind: "rate" | "usd" | "pct" | "n") => {
    // Suppress deltas when either side has no data — a delta vs. zero
    // baseline is misleading.
    if (v1Empty || v2Empty) return "—";
    const sign = d > 0 ? "+" : "";
    if (kind === "rate") return `${sign}${(d * 100).toFixed(1)}pp`;
    if (kind === "usd") return `${sign}${fmtUsd(d)}`;
    if (kind === "pct") return `${sign}${d.toFixed(2)}%`;
    return `${sign}${d}`;
  };
  const fmtVal = (label: "rate" | "usd" | "pct" | "n", entry: FrameworkEntry) => {
    if (entry.sample === 0) return "—";
    if (label === "rate") return fmtRate(entry.hit_rate);
    if (label === "usd") return fmtUsd(entry.total_pnl_usd);
    if (label === "pct")
      return entry.mean_realized_pct == null
        ? "—"
        : `${entry.mean_realized_pct.toFixed(2)}%`;
    return String(entry.sample);
  };
  const cell = (n: number) =>
    n > 0 ? "text-positive" : n < 0 ? "text-negative" : "text-fg";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Framework comparison (v1 vs v2.1)</CardTitle>
        <span className="text-xs text-fg-muted">
          per-framework aggregates · Δ = v2.1 − v1 (positive favors v2.1)
        </span>
      </CardHeader>
      {(v1Empty || v2Empty) ? (
        <div className="border-b border-line bg-warning/5 px-4 py-2 text-[11px] text-warning">
          {v1Empty && v2Empty ? (
            <>
              No outcomes recorded yet for either framework. The
              Compare view populates as signals fire and outcomes
              resolve (~24h after the first signal hits target/stop/
              flat).
            </>
          ) : v2Empty ? (
            <>
              v2.1 has no outcomes yet. Switch to v2.1 via the
              framework selector on{" "}
              <Link href="/alphaindex" className="underline">
                /alphaindex
              </Link>
              , or wait for the parallel runner to accumulate shadow
              outcomes (~24h). Empty cells render as "—" until the
              data lands.
            </>
          ) : (
            <>
              v1 has no outcomes yet. Once signals start firing under
              v1 the Compare cells populate automatically.
            </>
          )}
        </div>
      ) : null}
      <CardBody className="!p-0">
        <table className="w-full text-xs">
          <thead className="border-b border-line bg-surface-2">
            <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
              <th className="px-3 py-2 text-left">Metric</th>
              <th className="px-3 py-2 text-right">v1</th>
              <th className="px-3 py-2 text-right">v2.1</th>
              <th className="px-3 py-2 text-right">Δ (v2.1 advantage)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            <tr>
              <td className="px-3 py-2 text-fg">Hit rate</td>
              <td className="tabular px-3 py-2 text-right">{fmtVal("rate", summary.v1)}</td>
              <td className="tabular px-3 py-2 text-right">{fmtVal("rate", summary.v2)}</td>
              <td className={cn("tabular px-3 py-2 text-right font-semibold", cell(summary.delta.hit_rate))}>
                {fmtDelta(summary.delta.hit_rate, "rate")}
              </td>
            </tr>
            <tr>
              <td className="px-3 py-2 text-fg">Total realized P&amp;L</td>
              <td className="tabular px-3 py-2 text-right">{fmtVal("usd", summary.v1)}</td>
              <td className="tabular px-3 py-2 text-right">{fmtVal("usd", summary.v2)}</td>
              <td className={cn("tabular px-3 py-2 text-right font-semibold", cell(summary.delta.total_pnl_usd))}>
                {fmtDelta(summary.delta.total_pnl_usd, "usd")}
              </td>
            </tr>
            <tr>
              <td className="px-3 py-2 text-fg">Mean realized %</td>
              <td className="tabular px-3 py-2 text-right">{fmtVal("pct", summary.v1)}</td>
              <td className="tabular px-3 py-2 text-right">{fmtVal("pct", summary.v2)}</td>
              <td className={cn("tabular px-3 py-2 text-right font-semibold", cell(summary.delta.mean_realized_pct))}>
                {fmtDelta(summary.delta.mean_realized_pct, "pct")}
              </td>
            </tr>
            <tr>
              <td className="px-3 py-2 text-fg">Sample size (resolved)</td>
              <td className="tabular px-3 py-2 text-right">{summary.v1.sample}</td>
              <td className="tabular px-3 py-2 text-right">{summary.v2.sample}</td>
              <td className={cn("tabular px-3 py-2 text-right font-semibold", cell(summary.delta.sample))}>
                {fmtDelta(summary.delta.sample, "n")}
              </td>
            </tr>
          </tbody>
        </table>
      </CardBody>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Panel 1 — Hit rate by tier
// ─────────────────────────────────────────────────────────────────────

function PanelHitRateByTier({
  rows,
}: {
  rows: CalibrationPayload["by_tier"];
}) {
  const data = rows.map((r) => ({
    tier: r.tier.toUpperCase(),
    Wins: r.target_hit,
    Losses: r.stop_hit,
    Flat: r.flat,
    sample: r.sample,
    hit_rate: r.hit_rate,
  }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Hit rate by tier</CardTitle>
        <span className="text-xs text-fg-muted">
          target_hit / stop_hit / flat — excludes dismissed &amp; blocked
        </span>
      </CardHeader>
      <CardBody>
        <div className="h-64 w-full">
          <ResponsiveContainer>
            <BarChart data={data}>
              <CartesianGrid stroke="#1a1f2a" strokeDasharray="3 3" />
              <XAxis
                dataKey="tier"
                tick={{ fontSize: 11, fill: "#9aa3b2" }}
                stroke="#2a3340"
              />
              <YAxis tick={{ fontSize: 11, fill: "#9aa3b2" }} stroke="#2a3340" />
              <Tooltip
                contentStyle={{
                  background: "#0f1218",
                  border: "1px solid #2a3340",
                  borderRadius: 6,
                  fontSize: 11,
                  color: "#e6e9ef",
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Wins" stackId="a" fill="#22c55e" />
              <Bar dataKey="Flat" stackId="a" fill="#6b7280" />
              <Bar dataKey="Losses" stackId="a" fill="#ef4444" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
          {rows.map((r) => (
            <div
              key={r.tier}
              className="rounded border border-line bg-surface-2 px-2 py-1.5"
            >
              <div className="flex items-center gap-1.5">
                <Badge tone={r.tier === "auto" ? "accent" : r.tier === "review" ? "info" : "default"}>
                  {r.tier.toUpperCase()}
                </Badge>
                <span className="tabular text-fg">
                  {r.hit_rate != null
                    ? `${(r.hit_rate * 100).toFixed(0)}% hit`
                    : "—"}
                </span>
                <span className="ml-auto text-fg-dim">n={r.sample}</span>
              </div>
              <div className="text-fg-dim">
                avg{" "}
                <span className="tabular text-fg">
                  {r.mean_realized_pct != null
                    ? `${r.mean_realized_pct.toFixed(2)}%`
                    : "—"}
                </span>
              </div>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Panel 2 — Hit rate by catalyst subtype
// ─────────────────────────────────────────────────────────────────────

function PanelHitRateBySubtype({
  rows,
}: {
  rows: CalibrationPayload["by_subtype"];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Hit rate by catalyst subtype</CardTitle>
        <span className="text-xs text-fg-muted">
          {rows.length} subtypes (n &gt;= 5) — sorted by sample size
        </span>
      </CardHeader>
      <CardBody className="!p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-line bg-surface-2">
              <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                <th className="px-3 py-2 text-left">Subtype</th>
                <th className="px-3 py-2 text-right">N</th>
                <th className="px-3 py-2 text-right">% target</th>
                <th className="px-3 py-2 text-right">% stop</th>
                <th className="px-3 py-2 text-right">% flat</th>
                <th className="px-3 py-2 text-right">Mean</th>
                <th className="px-3 py-2 text-right">Median</th>
                <th className="px-3 py-2 text-right">Total PnL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-3 py-4 text-center text-fg-dim"
                  >
                    No subtypes with ≥5 resolved outcomes yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const pct = (n: number) =>
                    r.sample > 0 ? `${((n / r.sample) * 100).toFixed(0)}%` : "—";
                  return (
                    <tr
                      key={r.catalyst_subtype}
                      className="transition-colors hover:bg-surface-2"
                    >
                      <td className="px-3 py-2 font-mono text-fg">
                        {r.catalyst_subtype.replace(/_/g, " ")}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-fg-muted">
                        {r.sample}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-positive">
                        {pct(r.target_hit)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-negative">
                        {pct(r.stop_hit)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-fg-dim">
                        {pct(r.flat)}
                      </td>
                      <td
                        className={cn(
                          "tabular px-3 py-2 text-right",
                          (r.mean_realized_pct ?? 0) > 0
                            ? "text-positive"
                            : "text-negative",
                        )}
                      >
                        {r.mean_realized_pct != null
                          ? `${r.mean_realized_pct >= 0 ? "+" : ""}${r.mean_realized_pct.toFixed(2)}%`
                          : "—"}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-fg-muted">
                        {r.median_realized_pct != null
                          ? `${r.median_realized_pct >= 0 ? "+" : ""}${r.median_realized_pct.toFixed(2)}%`
                          : "—"}
                      </td>
                      <td
                        className={cn(
                          "tabular px-3 py-2 text-right",
                          r.total_pnl_usd > 0
                            ? "text-positive"
                            : r.total_pnl_usd < 0
                              ? "text-negative"
                              : "text-fg-dim",
                        )}
                      >
                        {fmtUsd(r.total_pnl_usd)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Panel 3 — Conviction calibration curve
// ─────────────────────────────────────────────────────────────────────

function PanelCalibrationCurve({
  bins,
}: {
  bins: CalibrationPayload["calibration_curve"];
}) {
  // Scatter: x = stated conviction, y = realized hit rate.
  // Diagonal y=x is "perfect calibration". Points above = under-confident;
  // points below = over-confident.
  const data = bins
    .filter((b) => b.hit_rate != null)
    .map((b) => ({
      stated: b.mean_conviction * 100,
      realized: (b.hit_rate ?? 0) * 100,
      sample: b.sample,
      bin: `${b.bin_start}-${b.bin_end}%`,
    }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conviction calibration curve</CardTitle>
        <span className="text-xs text-fg-muted">
          stated vs realized hit rate · y=x = perfect
        </span>
      </CardHeader>
      <CardBody>
        <div className="h-64 w-full">
          <ResponsiveContainer>
            <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid stroke="#1a1f2a" strokeDasharray="3 3" />
              <XAxis
                type="number"
                dataKey="stated"
                domain={[0, 100]}
                name="Stated conviction"
                tick={{ fontSize: 10, fill: "#9aa3b2" }}
                stroke="#2a3340"
                tickFormatter={(v) => `${v}%`}
              />
              <YAxis
                type="number"
                dataKey="realized"
                domain={[0, 100]}
                name="Realized hit rate"
                tick={{ fontSize: 10, fill: "#9aa3b2" }}
                stroke="#2a3340"
                tickFormatter={(v) => `${v}%`}
              />
              <ZAxis type="number" dataKey="sample" range={[20, 200]} name="Sample" />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                contentStyle={{
                  background: "#0f1218",
                  border: "1px solid #2a3340",
                  borderRadius: 6,
                  fontSize: 11,
                  color: "#e6e9ef",
                }}
                formatter={(v: unknown, name: unknown) => {
                  if (name === "sample") return [String(v), "n"];
                  return [`${(v as number).toFixed(0)}%`, String(name)];
                }}
              />
              {/* y = x reference line (perfect calibration) */}
              <ReferenceLine
                stroke="#7a8290"
                strokeDasharray="4 4"
                segment={[
                  { x: 0, y: 0 },
                  { x: 100, y: 100 },
                ]}
              />
              <Scatter data={data} fill="#ff7a45" />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-1 text-[10px] text-fg-dim">
          {bins.length === 0
            ? "Need resolved outcomes to compute a calibration curve."
            : "Points above the dashed line: under-confident. Below: over-confident."}
        </div>
      </CardBody>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Panel 4 — PnL by (subtype, asset_class)
// ─────────────────────────────────────────────────────────────────────

function PanelPnlGrid({ rows }: { rows: CalibrationPayload["pnl_grid"] }) {
  // Build a (subtype × asset_class) cell grid from the flat row list.
  const subtypes = Array.from(new Set(rows.map((r) => r.catalyst_subtype)));
  const assetClasses = Array.from(new Set(rows.map((r) => r.asset_class)));
  const cellByKey = new Map(
    rows.map((r) => [`${r.catalyst_subtype}|${r.asset_class}`, r]),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>PnL grid · catalyst × asset class</CardTitle>
        <span className="text-xs text-fg-muted">
          mean realized % per cell (sample size in parens) · n &gt;= 3
        </span>
      </CardHeader>
      <CardBody className="!p-0">
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-fg-dim">
            Need ≥3 resolved outcomes per (subtype, class) to populate the grid.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-line bg-surface-2">
                <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                  <th className="px-3 py-2 text-left">Subtype</th>
                  {assetClasses.map((c) => (
                    <th key={c} className="px-3 py-2 text-right">
                      {c.replace(/_/g, " ")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {subtypes.map((sub) => (
                  <tr key={sub}>
                    <td className="px-3 py-2 font-mono text-fg">
                      {sub.replace(/_/g, " ")}
                    </td>
                    {assetClasses.map((cls) => {
                      const cell = cellByKey.get(`${sub}|${cls}`);
                      if (!cell)
                        return (
                          <td
                            key={cls}
                            className="px-3 py-2 text-right text-fg-dim"
                          >
                            —
                          </td>
                        );
                      const v = cell.mean_realized_pct ?? 0;
                      return (
                        <td
                          key={cls}
                          className={cn(
                            "tabular px-3 py-2 text-right",
                            v > 0 ? "text-positive" : v < 0 ? "text-negative" : "",
                          )}
                        >
                          {v >= 0 ? "+" : ""}
                          {v.toFixed(1)}%{" "}
                          <span className="text-[10px] text-fg-dim">
                            (n={cell.sample})
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Panel 5 — Top winners + losers
// ─────────────────────────────────────────────────────────────────────

function PanelExtremes({
  winners,
  losers,
}: {
  winners: ExtremeRow[];
  losers: ExtremeRow[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top winners &amp; losers</CardTitle>
        <span className="text-xs text-fg-muted">
          forensics · click to open audit
        </span>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <ExtremeList title="Top winners" rows={winners} positive />
        <ExtremeList title="Worst losers" rows={losers} positive={false} />
      </CardBody>
    </Card>
  );
}

function ExtremeList({
  title,
  rows,
  positive,
}: {
  title: string;
  rows: ExtremeRow[];
  positive: boolean;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-dim">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="rounded border border-line bg-surface-2 px-3 py-2 text-[11px] text-fg-dim">
          None yet.
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((r) => (
            <li
              key={r.signal_id}
              className="flex items-baseline gap-2 rounded border border-line bg-surface-2 px-2 py-1 text-[11px]"
            >
              <Badge tone={r.direction === "long" ? "positive" : "negative"} mono>
                {r.direction.toUpperCase()}
              </Badge>
              <span className="font-mono font-medium text-fg">
                {r.asset_id.replace(/^[a-z]+-/, "").toUpperCase()}
              </span>
              <span
                className={cn(
                  "tabular ml-auto font-semibold",
                  positive ? "text-positive" : "text-negative",
                )}
              >
                {(r.realized_pct ?? 0) >= 0 ? "+" : ""}
                {(r.realized_pct ?? 0).toFixed(2)}%
              </span>
              <Link
                href={`/signal/${r.signal_id}`}
                className="text-fg-dim hover:text-accent-2 hover:underline"
                title={`audit ${r.signal_id}`}
              >
                audit →
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
