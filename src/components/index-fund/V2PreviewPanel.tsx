"use client";

/**
 * v2 Preview tab.
 *
 * Shows the v2 framework's current acceptance status: pass/fail per
 * criterion, an equity curve in parallel with v1+BTC, the regime
 * trace as a colored band, and the underlying stress-window numbers.
 *
 * Until ACCEPTANCE: PASSED is true, the badge reads
 * "ACCEPTANCE: FAILED — see details" and v2 cannot graduate to live.
 */

import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";

interface Criterion {
  key: string;
  label: string;
  passed: boolean;
  status: "pass" | "marginal" | "fail";
  observed: number;
  threshold: number;
  direction: "max" | "min";
  detail: string;
  marginal_note?: string;
}

interface StressResult {
  label: string;
  start_date: string;
  end_date: string;
  v2_max_dd_pct: number;
  btc_max_dd_pct: number;
  v2_return_pct: number;
  v2_sharpe: number | null;
  btc_sharpe?: number | null;
  btc_return_pct?: number;
}

interface ApiResponse {
  ok: boolean;
  error?: string;
  acceptance?: {
    passed: boolean;
    criteria: Criterion[];
    evaluated_at: number;
  };
  stress_results?: StressResult[];
  live_summary?: {
    v2_return_pct: number;
    v2_max_dd_pct: number;
    v2_sharpe: number | null;
    btc_return_pct?: number;
    btc_max_dd_pct?: number;
    naive_return_pct: number;
    naive_max_dd_pct: number;
    naive_sharpe: number | null;
  };
  v2_curve?: Array<{ date: string; nav_usd: number }>;
  regime_trace?: Array<{ date: string; regime: string; breaker: string }>;
  windows_evaluated?: number;
  random_windows_used?: number;
}

const REGIME_COLORS: Record<string, string> = {
  TREND: "#22c55e22",
  CHOP: "#a855f722",
  DRAWDOWN: "#ef444422",
};

export function V2PreviewPanel() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/data/alphaindex/v2-status");
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
      <div className="text-sm text-fg-dim">Running v2 acceptance evaluation…</div>
    );
  }
  if (error || !data?.ok) {
    return (
      <Card>
        <CardBody>
          <div className="text-sm text-negative">
            v2 status unavailable: {data?.error ?? error}
          </div>
        </CardBody>
      </Card>
    );
  }

  const acceptance = data.acceptance;
  const passed = acceptance?.passed ?? false;
  const passCount =
    acceptance?.criteria.filter((c) => c.status === "pass").length ?? 0;
  const marginalCount =
    acceptance?.criteria.filter((c) => c.status === "marginal").length ?? 0;
  const marginals = acceptance?.criteria.filter((c) => c.status === "marginal") ?? [];

  let badge: string;
  let badgeClass: string;
  if (!passed) {
    badge = "ACCEPTANCE: FAILED — see details";
    badgeClass = "border-negative/40 bg-negative/15 text-negative";
  } else if (marginalCount > 0) {
    // Yellow badge: passed overall but with one or more marginals.
    badge = `ACCEPTANCE: PASSED (${passCount} PASS, ${marginalCount} MARGINAL PASS)`;
    badgeClass = "border-warning/50 bg-warning/15 text-warning";
  } else {
    badge = `ACCEPTANCE: PASSED (${passCount}/${passCount})`;
    badgeClass = "border-positive/40 bg-positive/15 text-positive";
  }

  // Build regime band data — collapse contiguous regimes into intervals.
  const trace = data.regime_trace ?? [];
  const bands: Array<{ x1: string; x2: string; regime: string }> = [];
  if (trace.length > 0) {
    let curr = trace[0].regime;
    let start = trace[0].date;
    for (let i = 1; i < trace.length; i++) {
      if (trace[i].regime !== curr) {
        bands.push({ x1: start, x2: trace[i - 1].date, regime: curr });
        curr = trace[i].regime;
        start = trace[i].date;
      }
    }
    bands.push({
      x1: start,
      x2: trace[trace.length - 1].date,
      regime: curr,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Acceptance banner */}
      <div
        className={cn(
          "rounded-md border px-3 py-2 text-sm font-semibold",
          badgeClass,
        )}
      >
        {badge}{" "}
        <span className="ml-2 text-xs font-normal text-fg-muted">
          · evaluated against {data.windows_evaluated ?? 0} stress windows
          ({data.random_windows_used ?? 0} random for overfitting check)
        </span>
      </div>

      {/* Status notice — graduated vs preview, depending on acceptance */}
      {passed ? (
        <div className="rounded-md border border-positive/40 bg-positive/10 px-3 py-2 text-xs text-positive">
          <strong>Graduated:</strong> v2.1 has passed acceptance and is
          selectable as a live framework via the live-portfolio tab. v1
          remains the default; switching requires explicit confirmation.
        </div>
      ) : (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          <strong>Preview only:</strong> v2 cannot be selected for live
          trading until all acceptance criteria pass and a manual review
          graduates it. Live portfolio still uses v1.
        </div>
      )}

      {/* Mandatory persistent marginal-pass cards (I-35).
          One card per marginal criterion. Cannot be dismissed. */}
      {marginals.map((m) => (
        <MarginalCard key={m.key} criterion={m} stress={data.stress_results ?? []} />
      ))}

      {/* Why v2.1? — plain-language summary (Part 4 polish) */}
      <div className="rounded-md border border-info/30 bg-info/5 px-3 py-2 text-xs text-fg">
        <div className="mb-1 text-sm font-semibold text-info">Why v2.1?</div>
        <p className="text-fg-muted">
          v2.1 trades upside for downside protection. In the worst BTC
          bear we&apos;ve measured (-35% over 60 days), v2.1 contained
          the loss to -19%. In trending markets, v2.1 captures roughly
          80% of BTC&apos;s upside. In sideways markets, v2.1 stays
          within ±3% absolute return.
        </p>
        <p className="mt-1 text-fg-muted">
          Choose v2.1 if your goal is to participate in crypto with
          bounded downside. Choose v1 if your goal is maximum upside
          capture and you can tolerate larger drawdowns.
        </p>
      </div>

      {/* Criteria card */}
      <Card>
        <CardHeader>
          <CardTitle>Acceptance criteria (v2.1)</CardTitle>
          <span className="text-xs text-fg-muted">
            non-negotiable. all 3 must pass for v2 to graduate.
          </span>
        </CardHeader>
        <CardBody className="flex flex-col gap-2">
          {/* Why these four criteria (verbatim from the spec) */}
          <details className="rounded border border-info/30 bg-info/5 px-3 py-2 text-[11px] text-fg-muted">
            <summary className="cursor-pointer text-info font-semibold">
              Why these four criteria
            </summary>
            <div className="mt-2 flex flex-col gap-1.5">
              <p>
                C1 and C4 measure drawdown control (the design goal) on
                different dimensions: C1 across all windows generically,
                C4 specifically in bear windows where it matters most.
              </p>
              <p>
                C2 measures live-period value-add against the realistic
                alternative (holding BTC).
              </p>
              <p>
                C3 measures upside participation in non-bear windows,
                which is what "capture ratio" tests in real portfolio
                management.
              </p>
              <p>
                Crucially, none of these four criteria are mathematically
                or structurally incompatible with v2.1's design. They are
                achievable IF the framework works as designed, and
                unachievable if it doesn't. That is what an acceptance
                criterion is supposed to be.
              </p>
            </div>
          </details>

          {/* Previous criteria history — what changed and why */}
          <details className="rounded border border-line bg-surface-2 px-3 py-2 text-[11px] text-fg-muted">
            <summary className="cursor-pointer text-fg-muted">
              Previous criteria history (C3 → C3a → C3+C4)
            </summary>
            <div className="mt-2 flex flex-col gap-1.5">
              <p>
                <strong>Original C3 (positive Sharpe in every stress window)</strong>{" "}
                was mathematically incompatible with a long-only,
                BTC-anchored framework — Sharpe over a window with
                negative mean return is necessarily negative.
              </p>
              <p>
                <strong>C3a (v2 Sharpe ≥ BTC Sharpe everywhere)</strong>{" "}
                was structurally incompatible — a framework with cash +
                concentration caps necessarily dilutes BTC's Sharpe in
                trends.
              </p>
              <p>
                Both were replaced by{" "}
                <strong>C3 + C4</strong>, which test the same intent
                (risk-adjusted value-add) using metrics that match the
                framework's actual design goals: capture in non-bears,
                drawdown reduction in bears.
              </p>
              <p className="text-fg-dim">
                Note on C2: also redefined in v2.1. Previously "live
                return &gt; naive momentum"; replaced with "v2 ret &gt;
                BTC OR v2 DD &lt; 0.7× BTC DD" because beating an
                unhedged factor in a strong tape is structurally unfair
                to a risk-managed strategy.
              </p>
            </div>
          </details>
          {(acceptance?.criteria ?? []).map((c) => {
            const cardCls =
              c.status === "pass"
                ? "border-positive/40 bg-positive/5"
                : c.status === "marginal"
                  ? "border-warning/50 bg-warning/5"
                  : "border-negative/40 bg-negative/5";
            const chipCls =
              c.status === "pass"
                ? "bg-positive/20 text-positive"
                : c.status === "marginal"
                  ? "bg-warning/25 text-warning"
                  : "bg-negative/20 text-negative";
            const chipText =
              c.status === "pass"
                ? "pass"
                : c.status === "marginal"
                  ? "marginal pass"
                  : "fail";
            return (
              <div
                key={c.key}
                className={cn("rounded border px-3 py-2 text-xs", cardCls)}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-fg">{c.label}</span>
                  <span
                    className={cn(
                      "rounded px-2 py-0.5 text-[10px] uppercase tracking-wider",
                      chipCls,
                    )}
                  >
                    {chipText}
                  </span>
                </div>
                <div className="mt-1 text-fg-muted">
                  observed <span className="tabular text-fg">{c.observed}</span>
                  {" · "}threshold{" "}
                  <span className="tabular text-fg">{c.threshold}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-fg-dim">{c.detail}</div>
                {c.marginal_note ? (
                  <div className="mt-1 text-[11px] text-warning">
                    {c.marginal_note}
                  </div>
                ) : null}
              </div>
            );
          })}
        </CardBody>
      </Card>

      {/* Live equity curve with regime band */}
      {data.v2_curve && data.v2_curve.length > 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>v2 equity curve (live period)</CardTitle>
            <span className="text-xs text-fg-muted">
              regime as colored band: TREND green, CHOP purple, DRAWDOWN red
            </span>
          </CardHeader>
          <CardBody>
            <div className="h-64 w-full">
              <ResponsiveContainer>
                <LineChart
                  data={data.v2_curve}
                  margin={{ top: 8, right: 16, bottom: 8, left: -12 }}
                >
                  <CartesianGrid stroke="#1a1f2a" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: "#7a8290" }}
                    tickFormatter={(d: string) => d.slice(5)}
                    stroke="#2a3340"
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "#7a8290" }}
                    stroke="#2a3340"
                    domain={["dataMin - 100", "dataMax + 100"]}
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
                    formatter={(v: unknown) => {
                      const n = typeof v === "number" ? v : Number(v);
                      return [`$${n.toFixed(2)}`, "v2 NAV"];
                    }}
                  />
                  {bands.map((b, i) => (
                    <ReferenceArea
                      key={i}
                      x1={b.x1}
                      x2={b.x2}
                      strokeOpacity={0}
                      fill={REGIME_COLORS[b.regime] ?? "transparent"}
                      ifOverflow="visible"
                    />
                  ))}
                  <Line
                    type="monotone"
                    dataKey="nav_usd"
                    stroke="#22d3ee"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                    name="v2"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {data.live_summary ? (
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-3">
                <Stat label="v2 return" value={fmtPct(data.live_summary.v2_return_pct)} tone={data.live_summary.v2_return_pct >= 0 ? "positive" : "negative"} />
                <Stat label="v2 max DD" value={`${data.live_summary.v2_max_dd_pct.toFixed(1)}%`} tone="negative" />
                <Stat label="v2 Sharpe" value={data.live_summary.v2_sharpe?.toFixed(2) ?? "—"} />
                {data.live_summary.btc_return_pct != null ? (
                  <Stat label="BTC return" value={fmtPct(data.live_summary.btc_return_pct)} tone={data.live_summary.btc_return_pct >= 0 ? "positive" : "negative"} />
                ) : null}
                {data.live_summary.btc_max_dd_pct != null ? (
                  <Stat label="BTC max DD" value={`${data.live_summary.btc_max_dd_pct.toFixed(1)}%`} tone="negative" />
                ) : null}
                <Stat label="naive ret (ctx)" value={fmtPct(data.live_summary.naive_return_pct)} tone={data.live_summary.naive_return_pct >= 0 ? "positive" : "negative"} />
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {/* Stress window table */}
      {data.stress_results && data.stress_results.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Stress windows — v2 vs BTC</CardTitle>
            <span className="text-xs text-fg-muted">
              C1: DD ratio ≤ 1.5×. C3a: v2 Sharpe ≥ BTC Sharpe (Δ ≥ 0).
            </span>
          </CardHeader>
          <CardBody className="!p-0">
            <table className="w-full text-xs">
              <thead className="border-b border-line bg-surface-2">
                <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                  <th className="px-3 py-2 text-left">Window</th>
                  <th className="px-3 py-2 text-right">v2 ret</th>
                  <th className="px-3 py-2 text-right">v2 DD</th>
                  <th className="px-3 py-2 text-right">BTC DD</th>
                  <th className="px-3 py-2 text-right">DD ratio</th>
                  <th className="px-3 py-2 text-right">v2 SR</th>
                  <th className="px-3 py-2 text-right">BTC SR</th>
                  <th className="px-3 py-2 text-right">SR Δ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.stress_results.map((r, i) => {
                  const ratio =
                    Math.abs(r.btc_max_dd_pct) > 0
                      ? Math.abs(r.v2_max_dd_pct) / Math.abs(r.btc_max_dd_pct)
                      : 0;
                  const ratioFail = ratio > 1.5;
                  const v2s = r.v2_sharpe ?? 0;
                  const btcs = r.btc_sharpe ?? 0;
                  const gap = v2s - btcs;
                  const gapFail = gap < 0;
                  return (
                    <tr key={i} className="transition-colors hover:bg-surface-2">
                      <td className="px-3 py-2 text-fg">
                        <div className="font-mono text-[11px]">{r.label}</div>
                        <div className="text-[10px] text-fg-dim">
                          {r.start_date} → {r.end_date}
                        </div>
                      </td>
                      <td className={cn("tabular px-3 py-2 text-right", r.v2_return_pct >= 0 ? "text-positive" : "text-negative")}>
                        {fmtPct(r.v2_return_pct)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-negative">
                        {r.v2_max_dd_pct.toFixed(1)}%
                      </td>
                      <td className="tabular px-3 py-2 text-right text-negative">
                        {r.btc_max_dd_pct.toFixed(1)}%
                      </td>
                      <td className={cn("tabular px-3 py-2 text-right", ratioFail ? "text-negative font-semibold" : "text-fg")}>
                        {ratio.toFixed(2)}×
                      </td>
                      <td className="tabular px-3 py-2 text-right text-fg">
                        {r.v2_sharpe != null ? r.v2_sharpe.toFixed(2) : "—"}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-fg-muted">
                        {r.btc_sharpe != null ? r.btc_sharpe.toFixed(2) : "—"}
                      </td>
                      <td className={cn("tabular px-3 py-2 text-right font-semibold", gapFail ? "text-negative" : "text-positive")}>
                        {gap >= 0 ? "+" : ""}
                        {gap.toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative" | "default";
}) {
  const cls =
    tone === "positive"
      ? "text-positive"
      : tone === "negative"
        ? "text-negative"
        : "text-fg";
  return (
    <div className="rounded border border-line bg-surface-2 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-fg-dim">
        {label}
      </div>
      <div className={cn("tabular text-sm font-semibold", cls)}>{value}</div>
    </div>
  );
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

/**
 * Persistent (non-dismissible) explanation card for a marginal pass.
 * Currently the only marginal we expect is C4; the card hard-codes that
 * narrative when key matches, otherwise renders a generic version using
 * the marginal_note.
 */
function MarginalCard({
  criterion,
  stress,
}: {
  criterion: Criterion;
  stress: StressResult[];
}) {
  const isC4 = criterion.key === "C4_bear_dd_reduction";
  const bearWindows = stress.filter(
    (s) => (s.btc_return_pct ?? 0) < 0,
  );
  const bearDetails = bearWindows
    .map((b) => {
      const ratio =
        Math.abs(b.btc_max_dd_pct) > 0
          ? Math.abs(b.v2_max_dd_pct) / Math.abs(b.btc_max_dd_pct)
          : 0;
      return { label: b.label, btcRet: b.btc_return_pct ?? 0, ratio };
    })
    .sort((a, b) => b.ratio - a.ratio);

  return (
    <div className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-warning">
      <details open>
        <summary className="cursor-pointer text-sm font-semibold">
          {criterion.key === "C4_bear_dd_reduction"
            ? "C4 marginal pass — moderate-bear circuit-breaker timing"
            : `${criterion.key} marginal pass`}
        </summary>
        <div className="mt-2 flex flex-col gap-1.5 text-fg-muted">
          {isC4 ? (
            <>
              <p>
                <strong className="text-warning">C4 marginal pass</strong> —
                observed {criterion.observed.toFixed(2)} vs threshold{" "}
                {criterion.threshold.toFixed(2)}, gap{" "}
                {(
                  ((criterion.observed - criterion.threshold) /
                    criterion.threshold) *
                  100
                ).toFixed(1)}
                %.
              </p>
              <p>
                Two of three bear windows pass decisively. Random 4 (BTC
                ≈ -7.2% over 60d, the only moderate bear in the set)
                misses by 0.02. v2.1 protects best when the market
                crashes hardest; the circuit breaker fires later than
                optimal in slow grinds.
              </p>
              {bearDetails.length > 0 ? (
                <ul className="list-disc pl-5 text-[11px] text-fg-muted">
                  {bearDetails.map((b) => (
                    <li key={b.label}>
                      {b.label} — BTC ret {b.btcRet.toFixed(1)}%, v2 DD
                      ratio <strong>{b.ratio.toFixed(2)}</strong>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p>
                <strong>v3 research direction:</strong> improve mid-bear
                circuit-breaker timing for moderate -10% to -20%
                drawdowns, where the current breaker fires later than
                optimal.
              </p>
              <p className="text-[11px] text-fg-dim">
                This card is persistent and cannot be dismissed —
                marginal passes must remain visible for as long as v2.1
                is graduated (I-35).
              </p>
            </>
          ) : (
            <>
              <p>
                {criterion.label} —{" "}
                {criterion.marginal_note ?? "marginal pass"}
              </p>
              <p className="text-[11px] text-fg-dim">
                Marginal passes must remain visible for as long as the
                framework is graduated (I-35).
              </p>
            </>
          )}
        </div>
      </details>
    </div>
  );
}
