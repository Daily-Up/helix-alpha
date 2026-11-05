"use client";

/**
 * Marketing + glance homepage. First impression for judges, users,
 * future grant reviewers. Designed to communicate the product's thesis
 * in 10 seconds, then prove it works in another 30.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Stat } from "@/components/ui/Stat";
import { Num } from "@/components/ui/Num";
import { Timestamp } from "@/components/ui/Timestamp";
import { AssetLogo } from "@/components/ui/AssetLogo";
import { cn } from "@/components/ui/cn";
import { LiveTradeCta } from "@/components/sodex/LiveTradeCta";
import { fmtAssetSymbol, fmtRelative } from "@/lib/format";

interface HomeData {
  counts: {
    total_events: number;
    total_classified: number;
    total_signals: number;
    total_briefings: number;
    last_event_at: number | null;
  };
  signal_stats: {
    total_pending: number;
    auto: number;
    review: number;
    info: number;
    avg_conf: number | null;
  };
  top_signals: Array<{
    id: string;
    asset_symbol: string;
    asset_kind: string;
    sodex_symbol: string | null;
    direction: "long" | "short";
    tier: "auto" | "review" | "info";
    confidence: number;
    fired_at: number;
    event_title: string | null;
    event_type: string | null;
  }>;
  recent_graded: Array<{
    signal_id: string;
    asset_symbol: string;
    asset_kind: string;
    sodex_symbol: string | null;
    direction: "long" | "short";
    outcome: "target_hit" | "stop_hit" | "flat";
    realized_pct: number | null;
    outcome_at: number | null;
  }>;
  wealth: {
    product_count: number;
    top_yield: { name: string; apy: number } | null;
    highlights: Array<{
      fund_id: string;
      name: string;
      category: string;
      metric_label: string;
      metric_value: number | null;
      change_pct: number | null;
    }>;
  };
  briefing: {
    date: string;
    headline: string;
    regime: "risk_on" | "risk_off" | "mixed" | "neutral";
    top_pick: {
      asset_id: string;
      asset_symbol: string;
      direction: "long" | "short" | "watch";
      thesis: string;
      conviction: number;
    } | null;
    generated_at: number;
  } | null;
  calibration: {
    /** Resolved outcomes (target_hit | stop_hit | flat) in the window. */
    graded: number;
    /** wins / graded, or null when nothing is graded yet. */
    hit_rate: number | null;
    /** When graded === 0: ms epoch the first pending outcome becomes gradable. */
    first_grade_at: number | null;
  };
}

const REGIME_TONE: Record<
  HomeData["briefing"] extends infer B
    ? B extends { regime: infer R }
      ? R extends string
        ? R
        : never
      : never
    : never,
  "positive" | "negative" | "warning" | "default"
> = {
  risk_on: "positive",
  risk_off: "negative",
  mixed: "warning",
  neutral: "default",
};

const REGIME_DOT: Record<
  "risk_on" | "risk_off" | "mixed" | "neutral",
  string
> = {
  risk_on: "bg-positive",
  risk_off: "bg-negative",
  mixed: "bg-accent",
  neutral: "bg-fg-dim",
};

const OUTCOME_META: Record<
  "target_hit" | "stop_hit" | "flat",
  { label: string; tone: "positive" | "negative" | "default" }
> = {
  target_hit: { label: "TARGET HIT", tone: "positive" },
  stop_hit: { label: "STOP HIT", tone: "negative" },
  flat: { label: "FLAT", tone: "default" },
};

/** Short date for "first grades <date>" — "today"/"imminently" near term. */
function fmtGradeDate(ms: number): string {
  if (ms <= Date.now()) return "imminently";
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) return "today";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function HomePage() {
  const [data, setData] = useState<HomeData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/data/home")
      .then((r) => r.json())
      .then((j: HomeData) => setData(j))
      .finally(() => setLoading(false));
  }, []);

  // A briefing older than 36h isn't "today's" — the generator (cron / tick)
  // has fallen behind. Tag it amber rather than presenting it as current.
  const briefingStale =
    data?.briefing != null &&
    Date.now() - data.briefing.generated_at > 36 * 60 * 60 * 1000;

  return (
    <div className="flex flex-col gap-6">
      {/* ── Masthead: identity + live status (the product leads, not a pitch) ── */}
      <header className="flex flex-col gap-4 border-b border-line pb-6 md:flex-row md:items-end md:justify-between">
        <div className="max-w-2xl">
          <div className="font-[var(--font-jetbrains-mono)] text-[10px] font-medium uppercase tracking-[0.22em] text-fg-dim">
            SoSoValue · SoDEX · Anthropic Claude
          </div>
          <h1 className="mt-3 font-[var(--font-fraunces)] text-[28px] font-light leading-[1.06] tracking-[-0.02em] text-fg md:text-[34px]">
            Event-driven alpha,{" "}
            <span className="italic text-accent-2">audited in the open.</span>
          </h1>
          <p className="mt-2.5 max-w-xl text-[13px] leading-relaxed text-fg-muted">
            Live news, classified by Claude into tiered signals, mapped to SoDEX
            markets and Wealth products, with every call graded against what
            actually happened.
          </p>
        </div>
        {data ? (
          <div className="flex shrink-0 items-center gap-5 font-[var(--font-jetbrains-mono)] text-[11px] text-fg-dim">
            {data.briefing && !briefingStale ? (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    REGIME_DOT[data.briefing.regime],
                  )}
                />
                {data.briefing.regime.replace("_", "-").toUpperCase()}
              </span>
            ) : null}
            {briefingStale ? (
              <span className="inline-flex items-center gap-1.5 text-warning">
                <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                BRIEFING DELAYED
              </span>
            ) : null}
            {data.counts.last_event_at ? (
              <span>
                last event{" "}
                <Timestamp ms={data.counts.last_event_at} mode="relative" />
              </span>
            ) : null}
          </div>
        ) : null}
      </header>

      {/* Convert demo visitors into live (fee-generating) SoDEX users —
          hidden automatically once the browser is connected. */}
      <LiveTradeCta context="dashboard" />

      {loading && !data ? (
        <div className="text-sm text-fg-dim">Loading live snapshot…</div>
      ) : null}

      {data ? (
        <>
          {/* ── Live snapshot stats ────────────────────────────── */}
          <section>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-fg-dim">
              Live snapshot
            </h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat
                label="Pending signals"
                value={data.signal_stats.total_pending}
                sub={`${data.signal_stats.auto} auto · ${data.signal_stats.review} review · ${data.signal_stats.info} info`}
                tone={data.signal_stats.total_pending > 0 ? "accent" : "default"}
              />
              <Stat
                label={
                  data.wealth.top_yield
                    ? `${data.wealth.top_yield.name} · 7D APY`
                    : "Wealth Index"
                }
                value={
                  data.wealth.top_yield
                    ? `${data.wealth.top_yield.apy.toFixed(2)}%`
                    : `${data.wealth.product_count}`
                }
                sub={`${data.wealth.product_count} live products · SoDEX Wealth`}
                tone="accent"
              />
              <Stat
                label="Signal hit rate"
                value={
                  data.calibration.hit_rate != null
                    ? `${Math.round(data.calibration.hit_rate * 100)}%`
                    : "—"
                }
                sub={
                  data.calibration.graded > 0
                    ? `${data.calibration.graded} graded`
                    : data.calibration.first_grade_at
                      ? `first grades ${fmtGradeDate(data.calibration.first_grade_at)}`
                      : "awaiting first grades"
                }
                tone={
                  data.calibration.graded >= 5 && data.calibration.hit_rate != null
                    ? data.calibration.hit_rate >= 0.55
                      ? "positive"
                      : data.calibration.hit_rate <= 0.45
                        ? "negative"
                        : "default"
                    : "default"
                }
              />
              <Stat
                label="Events processed"
                value={data.counts.total_events.toLocaleString()}
                sub={`${data.counts.total_classified.toLocaleString()} AI-classified`}
              />
            </div>
          </section>

          {/* ── Today's briefing (if any) ──────────────────────── */}
          {data.briefing ? (
            <section>
              <Card
                className={cn(
                  "overflow-hidden",
                  briefingStale ? "border-warning/40" : "border-accent/30",
                )}
              >
                <CardHeader>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="accent">DAILY BRIEFING</Badge>
                    <Badge tone={REGIME_TONE[data.briefing.regime]}>
                      {data.briefing.regime.toUpperCase().replace("_", "-")}
                    </Badge>
                    {briefingStale ? (
                      <Badge tone="warning">BRIEFING DELAYED</Badge>
                    ) : null}
                    <span
                      className={cn(
                        "ml-auto text-[11px]",
                        briefingStale ? "text-warning" : "text-fg-dim",
                      )}
                    >
                      {data.briefing.date} · generated{" "}
                      <Timestamp
                        ms={data.briefing.generated_at}
                        mode="relative"
                      />
                    </span>
                  </div>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                  <h3 className="text-base font-semibold text-fg md:text-lg">
                    {data.briefing.headline}
                  </h3>
                  {data.briefing.top_pick ? (
                    <div className="rounded border border-accent/30 bg-accent/5 p-3">
                      <div className="mb-1 flex items-center gap-2">
                        <span className="text-[10px] font-medium uppercase tracking-wider text-accent-2">
                          Top pick today
                        </span>
                        <Badge
                          tone={
                            data.briefing.top_pick.direction === "long"
                              ? "positive"
                              : data.briefing.top_pick.direction === "short"
                                ? "negative"
                                : "warning"
                          }
                          mono
                        >
                          {data.briefing.top_pick.direction.toUpperCase()}
                        </Badge>
                        <span className="font-mono text-sm font-semibold text-fg">
                          {fmtAssetSymbol(data.briefing.top_pick.asset_symbol)}
                        </span>
                        <span className="ml-auto text-xs text-fg-muted">
                          <Num
                            value={data.briefing.top_pick.conviction * 100}
                            unit="%"
                            dp={0}
                            tier="context"
                          />{" "}
                          conviction
                        </span>
                      </div>
                      <p className="text-xs text-fg-muted">
                        {data.briefing.top_pick.thesis}
                      </p>
                    </div>
                  ) : null}
                  <Link
                    href="/briefing"
                    className="self-start text-xs text-accent-2 hover:underline"
                  >
                    Read the full briefing →
                  </Link>
                </CardBody>
              </Card>
            </section>
          ) : (
            <section>
              <Card className="border-dashed border-line-2">
                <CardBody className="flex items-center justify-between gap-3 py-4">
                  <div>
                    <div className="text-sm text-fg">
                      No briefing for today yet.
                    </div>
                    <div className="text-xs text-fg-dim">
                      Generate one — Claude reads everything and produces a
                      3-paragraph market read in ~25 seconds.
                    </div>
                  </div>
                  <Link
                    href="/briefing"
                    className="rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent-2 hover:bg-accent/25"
                  >
                    Generate briefing →
                  </Link>
                </CardBody>
              </Card>
            </section>
          )}

          {/* ── Two-column: signals + index ────────────────────── */}
          <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* Top signals — fresh pending; falls back to recently graded */}
            <Card>
              <CardHeader>
                <CardTitle>
                  {data.top_signals.length === 0 &&
                  data.recent_graded.length > 0
                    ? "Recently graded"
                    : "Top pending signals"}
                </CardTitle>
                <Link
                  href="/signals"
                  className="text-[11px] text-accent-2 hover:underline"
                >
                  All signals →
                </Link>
              </CardHeader>
              <CardBody className="!p-0">
                {data.top_signals.length > 0 ? (
                  <ul className="divide-y divide-line">
                    {data.top_signals.map((s) => (
                      <li
                        key={s.id}
                        className="flex flex-col gap-1 px-4 py-3 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <AssetLogo symbol={s.asset_symbol} size={18} />
                          <Badge
                            tone={
                              s.tier === "auto"
                                ? "accent"
                                : s.tier === "review"
                                  ? "info"
                                  : "default"
                            }
                          >
                            {s.tier}
                          </Badge>
                          <Badge
                            tone={
                              s.direction === "long" ? "positive" : "negative"
                            }
                            mono
                          >
                            {s.direction.toUpperCase()}
                          </Badge>
                          <span className="font-mono text-sm font-semibold text-fg">
                            {fmtAssetSymbol(s.asset_symbol, s.asset_kind)}
                          </span>
                          {s.event_type ? (
                            <Badge tone="default">{s.event_type}</Badge>
                          ) : null}
                          <Num
                            value={s.confidence * 100}
                            unit="%"
                            dp={0}
                            tier="secondary"
                            className="ml-auto"
                          />
                        </div>
                        {s.event_title ? (
                          <div className="text-fg-muted">
                            {s.event_title.slice(0, 110)}
                            {s.event_title.length > 110 ? "…" : ""}
                          </div>
                        ) : null}
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] text-fg-dim">
                            fired <Timestamp ms={s.fired_at} mode="relative" />
                          </span>
                          {s.sodex_symbol ? (
                            <TradeLink
                              sodexSymbol={s.sodex_symbol}
                              side={s.direction}
                            />
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : data.recent_graded.length > 0 ? (
                  <ul className="divide-y divide-line">
                    <li className="px-4 pt-3 text-[10px] text-fg-dim">
                      No live signals right now — here are the latest graded
                      calls.
                    </li>
                    {data.recent_graded.map((g) => (
                      <li
                        key={g.signal_id}
                        className="flex flex-col gap-1 px-4 py-3 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <AssetLogo symbol={g.asset_symbol} size={18} />
                          <Badge
                            tone={
                              g.direction === "long" ? "positive" : "negative"
                            }
                            mono
                          >
                            {g.direction.toUpperCase()}
                          </Badge>
                          <span className="font-mono text-sm font-semibold text-fg">
                            {fmtAssetSymbol(g.asset_symbol, g.asset_kind)}
                          </span>
                          <Badge tone={OUTCOME_META[g.outcome].tone}>
                            {OUTCOME_META[g.outcome].label}
                          </Badge>
                          {g.realized_pct != null ? (
                            <Num
                              value={g.realized_pct}
                              unit="%"
                              sign
                              dp={2}
                              tone="auto"
                              tier="secondary"
                              className="ml-auto"
                            />
                          ) : null}
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] text-fg-dim">
                            graded{" "}
                            {g.outcome_at ? (
                              <Timestamp ms={g.outcome_at} mode="relative" />
                            ) : (
                              "—"
                            )}
                          </span>
                          {g.sodex_symbol ? (
                            <TradeLink
                              sodexSymbol={g.sodex_symbol}
                              side={g.direction}
                            />
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="px-4 py-6 text-sm text-fg-dim">
                    No pending signals right now.
                  </div>
                )}
              </CardBody>
            </Card>

            {/* Wealth highlights */}
            <Card>
              <CardHeader>
                <CardTitle>Wealth highlights</CardTitle>
                <Link
                  href="/wealth-index"
                  className="text-[11px] text-accent-2 hover:underline"
                >
                  Wealth Index →
                </Link>
              </CardHeader>
              <CardBody className="!p-0">
                {data.wealth.highlights.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-fg-dim">
                    Couldn&apos;t load SoDEX Wealth right now.
                  </div>
                ) : (
                  <ul className="divide-y divide-line">
                    {data.wealth.highlights.map((h) => (
                      <li key={h.fund_id}>
                        <Link
                          href={`/wealth/${encodeURIComponent(h.fund_id)}`}
                          className="flex items-center justify-between gap-2 px-4 py-3 text-xs transition-colors hover:bg-surface-2/40"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-fg">
                              {h.name}
                            </div>
                            <div className="text-[10px] uppercase tracking-wider text-fg-dim">
                              {h.metric_label}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-3">
                            <Num
                              value={h.metric_value}
                              unit="%"
                              sign
                              dp={2}
                              tone="auto"
                              tier="secondary"
                            />
                            {h.change_pct != null && (
                              <Num
                                value={h.change_pct}
                                unit="%"
                                sign
                                dp={2}
                                tone="auto"
                                tier="context"
                              />
                            )}
                            <span className="text-fg-dim">→</span>
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          </section>

          {/* ── How it works ──────────────────────────────────── */}
          <section>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-fg-dim">
              How it works
            </h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
              <PipelineStep
                n={1}
                title="Ingest"
                body="SoSoValue news feed + KOL stream + ETF flows + sector rotation pulled every cron tick."
              />
              <PipelineStep
                n={2}
                title="Classify"
                body="Claude tags each event with type / sentiment / severity / actionable / affected assets."
              />
              <PipelineStep
                n={3}
                title="Signal"
                body="Conviction = confidence × tradability × severity. Tiered into auto / review / info."
              />
              <PipelineStep
                n={4}
                title="Act"
                body="Execute signals live on SoDEX from the trade terminal; browse on-chain yield + RWA products in the Wealth Index."
              />
              <PipelineStep
                n={5}
                title="Calibrate"
                body="Every signal graded against measured T+1d/3d/7d outcomes. Hit rate fed back."
              />
            </div>
          </section>

          {/* ── Footer / data sources ────────────────────────── */}
          <section className="rounded-md border border-line bg-surface px-4 py-3 text-xs text-fg-dim">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>
                <span className="text-fg-muted">News + sectors + ETF + macro:</span>{" "}
                SoSoValue OpenAPI
              </span>
              <span>
                <span className="text-fg-muted">Trading venue:</span> SoDEX (perps + spot)
              </span>
              <span>
                <span className="text-fg-muted">Intelligence:</span> Anthropic Claude
              </span>
              {data.counts.last_event_at ? (
                <span className="ml-auto">
                  last event ingested {fmtRelative(data.counts.last_event_at)}
                </span>
              ) : null}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

/** Deep-link into the trade terminal with the signal's market + side preset,
 *  tagged ?src=event (the same attribution the Event Stream uses). Only
 *  rendered when the signal maps to a SoDEX market (sodex_symbol present). */
function TradeLink({
  sodexSymbol,
  side,
}: {
  sodexSymbol: string;
  side: "long" | "short";
}) {
  return (
    <Link
      href={`/trade?market=${encodeURIComponent(sodexSymbol)}&side=${side}&src=event`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-medium transition-colors",
        side === "long"
          ? "border-positive/40 bg-positive/10 text-positive hover:bg-positive/20"
          : "border-negative/40 bg-negative/10 text-negative hover:bg-negative/20",
      )}
      title={`Open ${sodexSymbol} in the terminal, ${side} preset`}
    >
      ▶ Trade {side.toUpperCase()}
    </Link>
  );
}

function PipelineStep({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-md border border-line bg-surface p-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/20 text-[10px] font-bold text-accent-2">
          {n}
        </span>
        <span className="text-xs font-semibold text-fg">{title}</span>
      </div>
      <p className="text-[11px] leading-snug text-fg-muted">{body}</p>
    </div>
  );
}
