"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Stat } from "@/components/ui/Stat";
import { HeroStat, SubStat } from "@/components/ui/HeroStat";
import { StatSkeleton, ChartSkeleton, PanelSkeleton } from "@/components/ui/Skeleton";
import { useBulkMountReveal } from "@/hooks/useMountReveal";
import { fmtPct, fmtUsd } from "@/lib/format";
import { cn } from "@/components/ui/cn";
import { AllocationDonut } from "./AllocationDonut";
import { HoldingsTable, type PositionView } from "./HoldingsTable";
import { NavChart } from "./NavChart";
import {
  RebalanceHistory,
  type RebalanceView,
} from "./RebalanceHistory";
import { StressTestsPanel } from "./StressTestsPanel";
import { SignalContributionPanel } from "./SignalContributionPanel";
import { V2PreviewPanel } from "./V2PreviewPanel";
import { FrameworkSelector } from "./FrameworkSelector";

interface IndexResponse {
  index: { id: string; name: string; description: string | null; starting_nav: number };
  is_backfill: boolean;
  risk: {
    vol_30d_annualized_pct: number | null;
    max_drawdown_pct: number | null;
    current_drawdown_pct: number | null;
    return_pct: number | null;
    btc_return_pct: number | null;
    alpha_vs_btc_pct: number | null;
    sharpe: number | null;
    sample_days: number;
  };
  settings: {
    auto_rebalance: boolean;
    min_position_pct: number;
    max_position_pct: number;
    cash_reserve_pct: number;
    review_with_claude: boolean;
  };
  nav: {
    total: number;
    invested: number;
    cash: number;
    starting: number;
    pnl_usd: number;
    pnl_pct: number;
  };
  positions: PositionView[];
  rebalances: RebalanceView[];
  nav_history: Array<{
    date: string;
    nav_usd: number;
    pnl_pct: number;
    btc_price: number | null;
    ssimag7_price: number | null;
  }>;
  benchmarks: { btc_now: number | null; ssimag7_now: number | null };
  benchmark_curves?: Array<{
    name: "naive_momentum_top7" | "hybrid_simple";
    nav_by_date: Record<string, number>;
    return_pct: number;
    max_drawdown_pct: number;
    sharpe: number | null;
  }>;
}

type Tab = "live" | "stress_tests" | "v2_preview";

export function IndexDashboard() {
  const [data, setData] = useState<IndexResponse | null>(null);
  const [busy, setBusy] = useState<"rebalance" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRebalanceMsg, setLastRebalanceMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("live");

  const fetchData = useCallback(async () => {
    try {
      const r = await fetch("/api/data/index-fund?id=alphacore");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const t = setInterval(fetchData, 30_000);
    return () => clearInterval(t);
  }, [fetchData]);

  const rebalance = useCallback(async () => {
    setBusy("rebalance");
    setLastRebalanceMsg(null);
    try {
      const r = await fetch(
        "/api/cron/rebalance-index?triggered_by=manual",
        { method: "POST" },
      );
      const json = await r.json();
      if (!json.ok) throw new Error(json.error ?? "rebalance failed");
      const sumLine = json.summary ?? "";
      setLastRebalanceMsg(typeof sumLine === "string" ? sumLine : "ok");
      await fetchData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [fetchData]);

  const revealRef = useBulkMountReveal();

  if (!data) {
    if (error) {
      return (
        <div className="rounded border border-line bg-surface p-6 text-sm text-negative">
          Error: {error}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <StatSkeleton key={i} />)}
        </div>
        <ChartSkeleton height="h-64" />
        <PanelSkeleton height="h-48" />
      </div>
    );
  }

  return (
    <div ref={revealRef} className="dash-crossfade-enter flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-fg">{data.index.name}</h2>
          <p className="max-w-xl text-xs text-fg-muted">
            {data.index.description}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <FrameworkSelector />
          <a
            href="/calibration?compare=1"
            onClick={(e) => {
              // Lightweight nav — calibration page reads ?compare=1 to
              // start in Compare view (Part 2 of v2.1 attribution UI).
              e.preventDefault();
              window.location.href = "/calibration?compare=1";
            }}
            className="rounded border border-line bg-surface-2 px-2 py-1 text-[11px] text-fg-muted hover:border-line-2"
            title="Both frameworks run paper-traded in parallel — view side-by-side"
          >
            Shadow framework running in parallel · view comparison →
          </a>
          <button
            onClick={rebalance}
            disabled={busy !== null}
            className={cn(
              "dash-btn-primary rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
              busy === "rebalance"
                ? "cursor-wait border-line bg-surface-2 text-fg-dim"
                : "border-accent/40 bg-accent/15 text-accent-2 hover:bg-accent/25",
            )}
          >
            {busy === "rebalance" ? "Rebalancing…" : "▶ Rebalance Now"}
          </button>
        </div>
      </div>

      {lastRebalanceMsg ? (
        <div className="rounded border border-info/30 bg-info/10 px-3 py-1.5 text-xs text-info">
          {lastRebalanceMsg}
        </div>
      ) : null}

      {/* Tab control: live portfolio vs historical stress tests.
          The two are loaded independently — if the stress-tests endpoint
          errors, the live tab still works (and vice versa). */}
      <div className="flex items-center gap-2 text-xs">
        <button
          onClick={() => setTab("live")}
          className={cn(
            "dash-tab-trigger rounded border px-3 py-1 transition-colors",
            tab === "live"
              ? "dash-tab-active border-accent bg-accent/15 text-accent-2"
              : "border-line text-fg-muted hover:border-line-2",
          )}
        >
          Live portfolio
        </button>
        <button
          onClick={() => setTab("stress_tests")}
          className={cn(
            "dash-tab-trigger rounded border px-3 py-1 transition-colors",
            tab === "stress_tests"
              ? "dash-tab-active border-accent bg-accent/15 text-accent-2"
              : "border-line text-fg-muted hover:border-line-2",
          )}
        >
          Stress tests
        </button>
        <button
          onClick={() => setTab("v2_preview")}
          className={cn(
            "dash-tab-trigger rounded border px-3 py-1 transition-colors",
            tab === "v2_preview"
              ? "dash-tab-active border-accent bg-accent/15 text-accent-2"
              : "border-line text-fg-muted hover:border-line-2",
          )}
        >
          v2 (preview)
        </button>
      </div>

      {tab === "stress_tests" ? <StressTestsPanel /> : null}
      {tab === "v2_preview" ? <V2PreviewPanel /> : null}

      {/* Live tab content — preserved verbatim from pre-Part-1 layout.
          Hidden when stress-tests tab is active so the page renders one
          section at a time. The closing `)}` for this conditional sits
          at the bottom of the component, right before the outer </div>. */}
      {tab === "live" && (<>

      {/* Headline: NAV. Supporting stats sit as a thin row beneath
          the hero — landing's stats-strip pattern. */}
      <div className="mt-2 flex flex-col gap-6">
        <HeroStat
          label="Net asset value"
          value={fmtUsd(data.nav.total)}
          change={`${data.nav.pnl_usd >= 0 ? "+" : ""}${fmtUsd(data.nav.pnl_usd)} · ${fmtPct(data.nav.pnl_pct)}`}
          changeTone={
            data.nav.pnl_usd > 0
              ? "positive"
              : data.nav.pnl_usd < 0
                ? "negative"
                : "neutral"
          }
          sub={`from ${fmtUsd(data.nav.starting)} starting · ${data.risk.sample_days}d`}
        />
        <div className="grid grid-cols-2 gap-x-10 md:max-w-[820px] md:grid-cols-4">
          <SubStat
            label="Invested"
            value={fmtUsd(data.nav.invested)}
            sub={`${data.positions.length} positions`}
          />
          <SubStat
            label="Cash"
            value={fmtUsd(data.nav.cash)}
            sub={`target ${data.settings.cash_reserve_pct}%`}
          />
          <SubStat
            label="Auto-Rebalance"
            value={data.settings.auto_rebalance ? "ON" : "OFF"}
            sub={
              data.settings.review_with_claude
                ? "Claude reviews each plan"
                : "rules-only"
            }
            tone={data.settings.auto_rebalance ? "positive" : "neutral"}
          />
          <SubStat
            label="Sharpe"
            value={data.risk.sharpe != null ? data.risk.sharpe.toFixed(2) : "—"}
            sub={`${data.risk.sample_days}d window`}
            tone={
              (data.risk.sharpe ?? 0) > 1
                ? "positive"
                : (data.risk.sharpe ?? 0) < 0
                  ? "negative"
                  : "neutral"
            }
          />
        </div>
      </div>

      {/* NAV chart + risk metrics */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Equity curve</CardTitle>
            <span className="text-xs text-fg-muted">
              {data.risk.sample_days}d history · normalized to 100
            </span>
          </CardHeader>
          <CardBody>
            <NavChart
              history={data.nav_history}
              isBackfill={data.is_backfill}
              benchmarkCurves={data.benchmark_curves ?? []}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Risk &amp; performance</CardTitle>
            <span className="text-xs text-fg-muted">
              {data.risk.sample_days}d window
            </span>
          </CardHeader>
          <CardBody className="grid grid-cols-2 gap-2 text-xs">
            <RiskRow
              label="Return"
              value={fmtPct(data.risk.return_pct ?? 0)}
              tone={
                (data.risk.return_pct ?? 0) > 0
                  ? "positive"
                  : (data.risk.return_pct ?? 0) < 0
                    ? "negative"
                    : "default"
              }
            />
            <RiskRow
              label="vs BTC"
              value={fmtPct(data.risk.alpha_vs_btc_pct ?? 0)}
              sub={`BTC ${fmtPct(data.risk.btc_return_pct ?? 0)}`}
              tone={
                (data.risk.alpha_vs_btc_pct ?? 0) > 0
                  ? "positive"
                  : (data.risk.alpha_vs_btc_pct ?? 0) < 0
                    ? "negative"
                    : "default"
              }
            />
            <RiskRow
              label="Max drawdown"
              value={
                data.risk.max_drawdown_pct != null
                  ? `${data.risk.max_drawdown_pct.toFixed(1)}%`
                  : "—"
              }
              tone="negative"
            />
            <RiskRow
              label="Current DD"
              value={
                data.risk.current_drawdown_pct != null
                  ? `${data.risk.current_drawdown_pct.toFixed(1)}%`
                  : "—"
              }
              tone={
                (data.risk.current_drawdown_pct ?? 0) < -1
                  ? "negative"
                  : "default"
              }
            />
            <RiskRow
              label="Vol (30d ann.)"
              value={
                data.risk.vol_30d_annualized_pct != null
                  ? `${data.risk.vol_30d_annualized_pct.toFixed(1)}%`
                  : "—"
              }
            />
            <RiskRow
              label="Sharpe (rf=0)"
              value={
                data.risk.sharpe != null
                  ? data.risk.sharpe.toFixed(2)
                  : "—"
              }
              tone={
                (data.risk.sharpe ?? 0) > 1
                  ? "positive"
                  : (data.risk.sharpe ?? 0) < 0
                    ? "negative"
                    : "default"
              }
            />
          </CardBody>
        </Card>
      </div>

      {/* Holdings + Allocation */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Holdings</CardTitle>
            <span className="text-xs text-fg-muted">
              live mark-to-market · refreshes every 30s
            </span>
          </CardHeader>
          <CardBody className="p-0">
            <HoldingsTable
              positions={data.positions}
              cashUsd={data.nav.cash}
              navTotal={data.nav.total}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Allocation</CardTitle>
            <span className="text-xs text-fg-muted">current weights</span>
          </CardHeader>
          <CardBody>
            <AllocationDonut
              positions={data.positions}
              cashUsd={data.nav.cash}
              navTotal={data.nav.total}
            />
          </CardBody>
        </Card>
      </div>

      {/* Signal contribution panel — Part 3.
          Loads independently; failure here does not affect the live tab. */}
      <div className="">
        <SignalContributionPanel />
      </div>

      {/* Rebalance history */}
      <Card className="">
        <CardHeader>
          <CardTitle>Rebalance History</CardTitle>
          <span className="text-xs text-fg-muted">
            {data.rebalances.length} rebalances logged
          </span>
        </CardHeader>
        <CardBody>
          <RebalanceHistory rebalances={data.rebalances} />
        </CardBody>
      </Card>

      </>)}
    </div>
  );
}

/**
 * One row in the Risk &amp; performance card. Two-line layout: big number
 * with optional small sub-text. Tone tints the value (green/red/neutral).
 */
function RiskRow({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "positive" | "negative" | "default";
}) {
  const valueClass =
    tone === "positive"
      ? "text-positive"
      : tone === "negative"
        ? "text-negative"
        : "text-fg";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-fg-dim">
        {label}
      </span>
      <span className={cn("tabular text-sm font-semibold", valueClass)}>
        {value}
      </span>
      {sub ? <span className="text-[10px] text-fg-dim">{sub}</span> : null}
    </div>
  );
}
