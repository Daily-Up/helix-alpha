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
import { fmtAssetSymbol, fmtRelative, fmtUsd } from "@/lib/format";
import { cn } from "@/components/ui/cn";

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
    direction: "long" | "short";
    tier: "auto" | "review" | "info";
    confidence: number;
    fired_at: number;
    event_title: string | null;
    event_type: string | null;
  }>;
  index: {
    nav: number;
    starting_nav: number;
    pnl_pct: number;
    top_positions: Array<{
      symbol: string;
      kind?: string;
      weight_pct: number;
      pnl_pct: number | null;
      rationale: string | null;
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
    overall: {
      total_signals: number;
      evaluable: number;
      hit_rate_3d: number | null;
      avg_pnl_pct_3d: number | null;
    };
    best_event_type: {
      key: string;
      count: number;
      hit_rate_3d: number | null;
      avg_pnl_pct_3d: number | null;
    } | null;
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

export function HomePage() {
  const [data, setData] = useState<HomeData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/data/home")
      .then((r) => r.json())
      .then((j: HomeData) => setData(j))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex flex-col gap-8">
      {/* ── Hero ────────────────────────────────────────────── */}
      <section className="rounded-md border border-line bg-gradient-to-br from-surface to-surface-2 px-6 py-8 md:px-8 md:py-10">
        <div className="flex flex-col gap-2">
          <span className="inline-flex w-max items-center gap-1 rounded bg-accent/15 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-accent-2">
            SoSoValue × SoDEX × Claude
          </span>
          <h1 className="text-2xl font-semibold leading-tight text-fg md:text-3xl">
            Event-driven alpha for crypto and crypto-stocks.
          </h1>
          <p className="max-w-2xl text-sm text-fg-muted md:text-base">
            Helix reads every news event in real time, classifies it with
            Claude, generates tiered trade signals, manages a paper portfolio
            against momentum + signals, and grades its own track record. All on
            one screen.
          </p>
        </div>

        {/* Pillar cards */}
        <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-3">
          <PillarCard
            badge="ALPHATRADE"
            title="Tactical signals"
            body="News → Claude classifier → Auto / Review / Info trade signals against SoDEX perps + spot pairs."
            href="/signals"
          />
          <PillarCard
            badge="ALPHAINDEX"
            title="AI-managed portfolio"
            body="Anchored allocation over BTC, ETH, MAG7, RWA + momentum tilts. Reviewed by Claude before each rebalance."
            href="/index-fund"
          />
          <PillarCard
            badge="DAILY BRIEFING"
            title="One-paragraph market read"
            body="Every morning Claude synthesizes pending signals, sectors, ETF flows + macro into a single trade thesis."
            href="/briefing"
          />
        </div>
      </section>

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
                label="AlphaIndex NAV"
                value={fmtUsd(data.index.nav)}
                sub={`${data.index.pnl_pct >= 0 ? "+" : ""}${data.index.pnl_pct.toFixed(2)}% all-time`}
                tone={
                  data.index.pnl_pct > 0
                    ? "positive"
                    : data.index.pnl_pct < 0
                      ? "negative"
                      : "default"
                }
              />
              <Stat
                label="3d hit rate"
                value={
                  data.calibration.overall.hit_rate_3d != null
                    ? `${(data.calibration.overall.hit_rate_3d * 100).toFixed(0)}%`
                    : "—"
                }
                sub={
                  data.calibration.overall.evaluable > 0
                    ? `n=${data.calibration.overall.evaluable} measured`
                    : "calibrating…"
                }
                tone={
                  (data.calibration.overall.hit_rate_3d ?? 0.5) >= 0.55
                    ? "positive"
                    : (data.calibration.overall.hit_rate_3d ?? 0.5) <= 0.45
                      ? "negative"
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
              <Card className="overflow-hidden border-accent/30">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Badge tone="accent">DAILY BRIEFING</Badge>
                    <Badge tone={REGIME_TONE[data.briefing.regime]}>
                      {data.briefing.regime.toUpperCase().replace("_", "-")}
                    </Badge>
                    <span className="ml-auto text-[11px] text-fg-dim">
                      {data.briefing.date} · generated{" "}
                      {fmtRelative(data.briefing.generated_at)}
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
                        <span className="ml-auto tabular text-xs text-fg-muted">
                          {(data.briefing.top_pick.conviction * 100).toFixed(0)}
                          % conviction
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
            {/* Top signals */}
            <Card>
              <CardHeader>
                <CardTitle>Top pending signals</CardTitle>
                <Link
                  href="/signals"
                  className="text-[11px] text-accent-2 hover:underline"
                >
                  All signals →
                </Link>
              </CardHeader>
              <CardBody className="!p-0">
                {data.top_signals.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-fg-dim">
                    No pending signals right now.
                  </div>
                ) : (
                  <ul className="divide-y divide-line">
                    {data.top_signals.map((s) => (
                      <li
                        key={s.id}
                        className="flex flex-col gap-1 px-4 py-3 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-2">
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
                          <span className="ml-auto tabular text-fg-muted">
                            {(s.confidence * 100).toFixed(0)}%
                          </span>
                        </div>
                        {s.event_title ? (
                          <div className="text-fg-muted">
                            {s.event_title.slice(0, 110)}
                            {s.event_title.length > 110 ? "…" : ""}
                          </div>
                        ) : null}
                        <div className="text-[10px] text-fg-dim">
                          fired {fmtRelative(s.fired_at)}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>

            {/* Top index positions */}
            <Card>
              <CardHeader>
                <CardTitle>AlphaIndex top positions</CardTitle>
                <Link
                  href="/index-fund"
                  className="text-[11px] text-accent-2 hover:underline"
                >
                  Full portfolio →
                </Link>
              </CardHeader>
              <CardBody className="!p-0">
                {data.index.top_positions.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-fg-dim">
                    No positions yet — run a rebalance from /index-fund.
                  </div>
                ) : (
                  <ul className="divide-y divide-line">
                    {data.index.top_positions.map((p) => (
                      <li
                        key={p.symbol}
                        className="flex flex-col gap-1 px-4 py-3 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-fg">
                            {fmtAssetSymbol(p.symbol, p.kind)}
                          </span>
                          <span className="tabular text-fg">
                            {p.weight_pct.toFixed(2)}%
                          </span>
                          {p.pnl_pct != null ? (
                            <span
                              className={cn(
                                "tabular text-xs",
                                p.pnl_pct > 0
                                  ? "text-positive"
                                  : p.pnl_pct < 0
                                    ? "text-negative"
                                    : "text-fg-muted",
                              )}
                            >
                              {p.pnl_pct >= 0 ? "+" : ""}
                              {p.pnl_pct.toFixed(2)}%
                            </span>
                          ) : null}
                        </div>
                        {p.rationale ? (
                          <div className="text-[11px] text-fg-muted">
                            {p.rationale}
                          </div>
                        ) : null}
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
                title="Allocate"
                body="AlphaIndex anchored portfolio rebalances on signals + momentum, reviewed by Claude."
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

function PillarCard({
  badge,
  title,
  body,
  href,
}: {
  badge: string;
  title: string;
  body: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-md border border-line bg-surface p-4 transition-colors hover:border-accent/50 hover:bg-surface-2"
    >
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-accent-2">
        {badge}
      </div>
      <div className="mb-1 text-sm font-semibold text-fg">{title}</div>
      <div className="text-xs text-fg-muted">{body}</div>
      <div className="mt-2 text-[11px] text-accent-2 opacity-0 transition-opacity group-hover:opacity-100">
        Explore →
      </div>
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
