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
import { Stat } from "@/components/ui/Stat";
import { HeroStat, SubStat } from "@/components/ui/HeroStat";
import { Badge } from "@/components/ui/Badge";
import { StatSkeleton, PanelSkeleton } from "@/components/ui/Skeleton";
import { useBulkMountReveal } from "@/hooks/useMountReveal";
import { fmtRelative, truncate } from "@/lib/format";
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

function rateTone(v: number | null | undefined): string {
  if (v == null) return "text-fg-muted";
  if (v >= 0.6) return "text-positive";
  if (v >= 0.5) return "text-fg";
  if (v >= 0.4) return "text-fg-muted";
  return "text-negative";
}

function pnlTone(v: number | null | undefined): string {
  if (v == null) return "text-fg-muted";
  if (v > 0.5) return "text-positive";
  if (v < -0.5) return "text-negative";
  return "text-fg-muted";
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
  const impactKey = `impact_pct_${horizon}` as const;
  const pnlSignalKey = `pnl_pct_${horizon}` as const;

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
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-line bg-surface-2">
                <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                  <th className="px-3 py-2 text-left">Fired</th>
                  <th className="px-3 py-2 text-left">Asset</th>
                  <th className="px-3 py-2 text-left">Dir</th>
                  <th className="px-3 py-2 text-left">Tier</th>
                  <th className="px-3 py-2 text-right">Conf</th>
                  <th className="px-3 py-2 text-left">Event type</th>
                  <th className="px-3 py-2 text-left">News</th>
                  <th className="px-3 py-2 text-right">
                    PnL T+{horizon}
                  </th>
                  <th className="px-3 py-2 text-left">Hit?</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.recent.map((r) => {
                  const pnl = r[pnlSignalKey];
                  const impact = r[impactKey];
                  const measured = pnl != null;
                  const hit = measured ? pnl! > 0 : null;
                  return (
                    <tr
                      key={r.signal_id}
                      className="text-xs transition-colors hover:bg-surface-2"
                    >
                      <td className="px-3 py-2 text-fg-muted whitespace-nowrap">
                        {fmtRelative(r.fired_at)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-mono text-fg">
                          {r.asset_symbol}
                        </div>
                        <div className="text-[10px] text-fg-dim">
                          {r.asset_kind}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          tone={
                            r.direction === "long" ? "positive" : "negative"
                          }
                          mono
                        >
                          {r.direction.toUpperCase()}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
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
                      </td>
                      <td className="tabular px-3 py-2 text-right text-fg">
                        {(r.confidence * 100).toFixed(0)}%
                      </td>
                      <td className="px-3 py-2 text-fg-muted">
                        {r.event_type ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-fg-muted max-w-xs">
                        <span title={r.event_title ?? ""}>
                          {truncate(r.event_title ?? "—", 60)}
                        </span>
                      </td>
                      <td
                        className={cn(
                          "tabular px-3 py-2 text-right font-medium",
                          measured && (pnl! > 0 ? "text-positive" : "text-negative"),
                          !measured && "text-fg-dim",
                        )}
                      >
                        {pnl != null ? fmtPct(pnl) : "—"}
                        {impact != null ? (
                          <div className="text-[10px] font-normal text-fg-dim">
                            move {fmtPct(impact)}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        {hit == null ? (
                          <span className="text-fg-dim text-[11px]">
                            pending
                          </span>
                        ) : hit ? (
                          <Badge tone="positive">✓</Badge>
                        ) : (
                          <Badge tone="negative">✕</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {data.recent.length === 0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      className="px-4 py-6 text-center text-sm text-fg-dim"
                    >
                      No signals in this window yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
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
  const maxBucketCount = Math.max(1, ...rows.map((r) => r.count));

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
        <table className="w-full">
          <thead className="border-b border-line bg-surface-2">
            <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
              <th className="px-3 py-2 text-left">Bucket</th>
              <th className="px-3 py-2 text-right">N</th>
              <th className="px-3 py-2 text-right">Hit rate</th>
              <th className="px-3 py-2 text-right">Avg PnL</th>
              <th className="px-3 py-2 text-left w-24">Share</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {visible.map((r) => (
              <tr
                key={r.key}
                className="text-xs transition-colors hover:bg-surface-2"
              >
                <td className="px-3 py-2 font-mono text-fg">{r.key}</td>
                <td className="tabular px-3 py-2 text-right text-fg-muted">
                  {r.count}
                </td>
                <td
                  className={cn(
                    "tabular px-3 py-2 text-right font-medium",
                    rateTone(r[hitKey]),
                  )}
                >
                  {fmtRate(r[hitKey])}
                </td>
                <td
                  className={cn(
                    "tabular px-3 py-2 text-right",
                    pnlTone(r[pnlKey]),
                  )}
                >
                  {fmtPct(r[pnlKey])}
                </td>
                <td className="px-3 py-2">
                  <div className="h-1.5 rounded-full bg-surface-2 w-20">
                    <div
                      className="h-full rounded-full bg-accent/60"
                      style={{
                        width: `${(r.count / maxBucketCount) * 100}%`,
                      }}
                    />
                  </div>
                </td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-6 text-center text-sm text-fg-dim"
                >
                  No data yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </CardBody>
    </Card>
  );
}
