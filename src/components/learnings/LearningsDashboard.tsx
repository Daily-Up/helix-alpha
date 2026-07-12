"use client";

/**
 * Learnings dashboard — closes the loop on signal predictions.
 *
 * Shows the user how their signal pipeline actually performed, broken
 * down by confidence bucket (calibration), event type (which catalysts
 * are tradable), tier (auto vs review vs info), and asset kind.
 *
 * Hit rate definition: a signal is a "hit" at horizon H if the
 * directional move agreed with the signal direction. Realised PnL is
 * +impact for longs, -impact for shorts. We average across all
 * evaluable signals (those with measured impact_metrics).
 */

import { useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { HeroStat, SubStat } from "@/components/ui/HeroStat";
import { Badge } from "@/components/ui/Badge";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Timestamp } from "@/components/ui/Timestamp";
import { StatSkeleton, PanelSkeleton } from "@/components/ui/Skeleton";
import { useBulkMountReveal } from "@/hooks/useMountReveal";
import { truncate } from "@/lib/format";
import { cn } from "@/components/ui/cn";

type Horizon = "1d" | "3d" | "7d";
type Window = "7d" | "30d" | "90d" | "all";

interface BucketStats {
  key: string;
  count: number;
  hit_rate_1d: number | null;
  hit_rate_3d: number | null;
  hit_rate_7d: number | null;
  avg_pnl_pct_1d: number | null;
  avg_pnl_pct_3d: number | null;
  avg_pnl_pct_7d: number | null;
}

interface OverallStats {
  total_signals: number;
  evaluable: number;
  hit_rate_1d: number | null;
  hit_rate_3d: number | null;
  hit_rate_7d: number | null;
  avg_pnl_pct_1d: number | null;
  avg_pnl_pct_3d: number | null;
  avg_pnl_pct_7d: number | null;
}

interface SignalOutcomeRow {
  signal_id: string;
  fired_at: number;
  asset_id: string;
  asset_symbol: string;
  asset_kind: string;
  direction: "long" | "short";
  tier: "auto" | "review" | "info";
  confidence: number;
  event_type: string | null;
  event_title: string | null;
  reasoning: string;
  impact_pct_1d: number | null;
  impact_pct_3d: number | null;
  impact_pct_7d: number | null;
  pnl_pct_1d: number | null;
  pnl_pct_3d: number | null;
  pnl_pct_7d: number | null;
}

interface LearningsResponse {
  window: string;
  overall: OverallStats;
  by_confidence: BucketStats[];
  by_event_type: BucketStats[];
  by_tier: BucketStats[];
  by_asset_kind: BucketStats[];
  recent: SignalOutcomeRow[];
}

const WINDOW_OPTIONS: { value: Window; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "all", label: "All time" },
];

function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function fmtRate(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(0)}%`;
}

export function LearningsDashboard() {
  const [data, setData] = useState<LearningsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [windowSel, setWindowSel] = useState<Window>("30d");
  const [horizon, setHorizon] = useState<Horizon>("3d");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/data/learnings?window=${windowSel}`)
      .then((r) => r.json())
      .then((d: LearningsResponse) => {
        if (!cancelled) setData(d);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [windowSel]);

  const hitRateKey = `hit_rate_${horizon}` as const;
  const pnlKey = `avg_pnl_pct_${horizon}` as const;
  const pnlSignalKey = `pnl_pct_${horizon}` as const;

  // Recent-outcomes table: role-based columns. PnL carries the magnitude bar
  // (the one homogeneous signed number); the redundant Hit? ✓/✕ column is
  // dropped (it merely restated sign(PnL)) and the "move X%" subline is folded.
  const recentColumns: Column<SignalOutcomeRow>[] = [
    {
      key: "fired",
      header: "Fired",
      role: "context",
      align: "left",
      render: (r) => <Timestamp ms={r.fired_at} mode="relative" />,
    },
    {
      key: "asset",
      header: "Asset",
      role: "identifier",
      render: (r) => (
        <div className="flex flex-col leading-tight">
          <span className="font-mono text-fg">{r.asset_symbol}</span>
          <span className="text-[10px] text-fg-dim">{r.asset_kind}</span>
        </div>
      ),
    },
    {
      key: "dir",
      header: "Dir",
      role: "context",
      align: "left",
      render: (r) => (
        <Badge tone={r.direction === "long" ? "positive" : "negative"} mono>
          {r.direction.toUpperCase()}
        </Badge>
      ),
    },
    {
      key: "tier",
      header: "Tier",
      role: "context",
      align: "left",
      render: (r) => (
        <Badge
          tone={
            r.tier === "auto"
              ? "accent"
              : r.tier === "review"
                ? "info"
                : "default"
          }
        >
          {r.tier}
        </Badge>
      ),
    },
    {
      key: "conf",
      header: "Conf",
      role: "context",
      num: (r) => r.confidence * 100,
      unit: "%",
      dp: 0,
    },
    {
      key: "event",
      header: "Event",
      role: "context",
      align: "left",
      render: (r) => r.event_type ?? "—",
    },
    {
      key: "news",
      header: "News",
      role: "identifier",
      render: (r) => (
        <span
          title={r.event_title ?? undefined}
          className="whitespace-normal font-[var(--font-inter)] text-fg-muted"
        >
          {truncate(r.event_title ?? "—", 60)}
        </span>
      ),
    },
    {
      key: "pnl",
      header: `PnL T+${horizon}`,
      role: "magnitude",
      num: (r) => r[pnlSignalKey],
      unit: "%",
      sign: true,
      dp: 1,
      tone: "auto",
    },
  ];

  // Calibration insight: are higher-confidence signals actually winning more?
  const calibrationInsight = useMemo(() => {
    if (!data) return null;
    const buckets = data.by_confidence.filter((b) => b.count >= 3);
    if (buckets.length < 2) return null;
    const high = buckets.find(
      (b) => b.key === "0.90-1.00" || b.key === "0.80-0.90",
    );
    const low = buckets.find(
      (b) => b.key === "0.50-0.60" || b.key === "0.60-0.70",
    );
    if (!high || !low) return null;
    const highRate = high[hitRateKey];
    const lowRate = low[hitRateKey];
    if (highRate == null || lowRate == null) return null;
    const diff = highRate - lowRate;
    if (diff > 0.1)
      return {
        verdict: "calibrated" as const,
        text: `High-confidence signals (${high.key}) hit ${fmtRate(highRate)} vs. low-confidence (${low.key}) at ${fmtRate(lowRate)} — calibration looks healthy.`,
      };
    if (diff < -0.05)
      return {
        verdict: "inverted" as const,
        text: `⚠ Inverted calibration: high-confidence signals (${fmtRate(highRate)}) are doing WORSE than low-confidence (${fmtRate(lowRate)}). The model may be overconfident on the wrong signals.`,
      };
    return {
      verdict: "flat" as const,
      text: `Confidence isn't differentiating outcomes — high (${fmtRate(highRate)}) ≈ low (${fmtRate(lowRate)}). Tighten conviction inputs or accept that confidence is noise.`,
    };
  }, [data, hitRateKey]);

  const revealRef = useBulkMountReveal();

  if (loading && !data) {
    return (
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <StatSkeleton key={i} />)}
        </div>
        <PanelSkeleton height="h-48" />
        <PanelSkeleton height="h-48" />
      </div>
    );
  }

  if (!data) return null;

  const o = data.overall;

  return (
    <div ref={revealRef} className="dash-crossfade-enter flex flex-col gap-5">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 text-xs">
          <span className="text-fg-dim uppercase tracking-wider mr-1">
            Window
          </span>
          {WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setWindowSel(opt.value)}
              className={cn(
                "dash-tab-trigger rounded border px-2 py-1 transition-colors",
                windowSel === opt.value
                  ? "dash-tab-active border-accent bg-accent/15 text-accent-2"
                  : "border-line text-fg-muted hover:border-line-2 hover:text-fg",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-xs">
          <span className="text-fg-dim uppercase tracking-wider mr-1">
            Horizon
          </span>
          {(["1d", "3d", "7d"] as const).map((h) => (
            <button
              key={h}
              onClick={() => setHorizon(h)}
              className={cn(
                "dash-tab-trigger rounded border px-2 py-1 transition-colors",
                horizon === h
                  ? "dash-tab-active border-accent bg-accent/15 text-accent-2"
                  : "border-line text-fg-muted hover:border-line-2 hover:text-fg",
              )}
            >
              T+{h}
            </button>
          ))}
        </div>
      </div>

      {/* Headline: hit rate is the one number that says whether the
          signals are actually calling moves correctly. Others demoted.
          Empty state — when no signals have been measured at this
          horizon yet, render a clearer "awaiting data" sub rather
          than a huge em-dash with no context. */}
      <div className="mt-2 flex flex-col gap-6">
        <HeroStat
          label={`Hit rate · T+${horizon}`}
          // Empty-state legibility — an em-dash at 88px Fraunces renders as
          // a single thin line that looks like a broken layout. When the
          // horizon has no measured outcomes yet, surface a small typographic
          // placeholder ("—") plus a clear "no data" sub-line rather than
          // the giant glyph. Once data lands, the real percentage takes over.
          value={
            o[hitRateKey] == null
              ? "No data"
              : fmtRate(o[hitRateKey])
          }
          change={
            o[pnlKey] == null
              ? undefined
              : `Avg PnL ${fmtPct(o[pnlKey])} per signal`
          }
          changeTone={
            (o[pnlKey] ?? 0) > 0
              ? "positive"
              : (o[pnlKey] ?? 0) < 0
                ? "negative"
                : "neutral"
          }
          sub={
            o.evaluable === 0
              ? `${o.total_signals} signals fired · awaiting outcome resolution at T+${horizon}`
              : `vs 50% coin-flip baseline · ${o.evaluable}/${o.total_signals} measurable`
          }
        />
        <div className="grid grid-cols-3 gap-x-10 md:max-w-[640px]">
          <SubStat
            label="Signals fired"
            value={String(o.total_signals)}
            sub={`${o.evaluable} measurable`}
          />
          <SubStat
            label="Coverage"
            value={
              o.total_signals > 0
                ? `${Math.round((o.evaluable / o.total_signals) * 100)}%`
                : "—"
            }
            sub="signals with measured impact"
          />
          <SubStat
            label="Horizon"
            value={`T+${horizon}`}
            sub="measurement window"
          />
        </div>
      </div>

      {/* Calibration insight banner */}
      {calibrationInsight ? (
        <div
          className={cn(
            "rounded-md border px-4 py-3 text-sm",
            calibrationInsight.verdict === "calibrated" &&
              "border-positive/30 bg-positive/10 text-fg",
            calibrationInsight.verdict === "inverted" &&
              "border-negative/40 bg-negative/10 text-fg",
            calibrationInsight.verdict === "flat" &&
              "border-warning/30 bg-warning/10 text-fg",
          )}
        >
          {calibrationInsight.text}
        </div>
      ) : null}

      {/* Breakdowns */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BreakdownCard
          title="Confidence calibration"
          subtitle="Hit rate per confidence bucket — should rise with confidence."
          rows={data.by_confidence}
          horizon={horizon}
        />
        <BreakdownCard
          title="By event type"
          subtitle="Which catalysts are profitable to trade."
          rows={data.by_event_type}
          horizon={horizon}
          maxRows={10}
        />
        <BreakdownCard
          title="By tier"
          subtitle="Auto / Review / Info — does each tier earn its rank?"
          rows={data.by_tier}
          horizon={horizon}
        />
        <BreakdownCard
          title="By asset kind"
          subtitle="Token / stock / ETF / RWA — where the model is sharp."
          rows={data.by_asset_kind}
          horizon={horizon}
        />
      </div>

      {/* Recent signal outcomes */}
      <Card className="">
        <CardHeader>
          <CardTitle>Recent signal outcomes</CardTitle>
          <span className="text-[11px] text-fg-dim">
            Last {data.recent.length} signals (newest first)
          </span>
        </CardHeader>
        <CardBody className="p-0">
          {data.recent.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-fg-dim">
              No signals in this window yet.
            </div>
          ) : (
            <DataTable
              columns={recentColumns}
              rows={data.recent}
              getKey={(r) => r.signal_id}
              minWidth={760}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Breakdown card — one used four times for the four groupings
// ─────────────────────────────────────────────────────────────────────────

function BreakdownCard({
  title,
  subtitle,
  rows,
  horizon,
  maxRows = 8,
}: {
  title: string;
  subtitle?: string;
  rows: BucketStats[];
  horizon: Horizon;
  maxRows?: number;
}) {
  const hitKey = `hit_rate_${horizon}` as const;
  const pnlKey = `avg_pnl_pct_${horizon}` as const;
  const visible = rows.slice(0, maxRows);
  const totalCount = rows.reduce((a, r) => a + r.count, 0);

  // Avg PnL carries the magnitude bar (signed, real spread); hit rate is the
  // emphasised lead number (no threshold colour); N is quiet context. The
  // volume "Share" bar and the rateTone/pnlTone helpers are retired.
  const columns: Column<BucketStats>[] = [
    { key: "bucket", header: "Bucket", role: "identifier", render: (r) => r.key },
    { key: "n", header: "N", role: "context", num: (r) => r.count },
    {
      key: "hit",
      header: "Hit rate",
      role: "lead",
      num: (r) => {
        const v = r[hitKey];
        return v != null ? v * 100 : null;
      },
      unit: "%",
      dp: 0,
    },
    {
      key: "pnl",
      header: "Avg PnL",
      role: "magnitude",
      num: (r) => r[pnlKey],
      unit: "%",
      sign: true,
      dp: 1,
      tone: "auto",
    },
  ];

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {subtitle ? (
            <div className="mt-0.5 text-[11px] text-fg-dim normal-case tracking-normal">
              {subtitle}
            </div>
          ) : null}
        </div>
        <span className="text-[11px] text-fg-dim">{totalCount} signals</span>
      </CardHeader>
      <CardBody className="p-0">
        {visible.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-fg-dim">
            No data yet.
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={visible}
            getKey={(r) => r.key}
            minWidth={480}
          />
        )}
      </CardBody>
    </Card>
  );
}
