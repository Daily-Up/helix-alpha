"use client";

import { useEffect, useState } from "react";
import { Stat } from "@/components/ui/Stat";
import { HeroStat } from "@/components/ui/HeroStat";
import { Num } from "@/components/ui/Num";
import { Timestamp } from "@/components/ui/Timestamp";

interface StatsResponse {
  total_events: number;
  total_classified: number;
  unclassified: number;
  events_24h: number;
  sentiment_breakdown: Array<{ sentiment: string; n: number }>;
  event_type_breakdown: Array<{ event_type: string; n: number }>;
  last_run: {
    started_at: number;
    finished_at: number | null;
    status: string;
    summary: string | null;
  } | null;
}

export function StatsBar() {
  const [stats, setStats] = useState<StatsResponse | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch("/api/data/stats");
        if (res.ok) setStats(await res.json());
      } catch {
        // no-op
      }
    };
    fetchStats();
    const t = setInterval(fetchStats, 30_000);
    return () => clearInterval(t);
  }, []);

  const bull = stats?.sentiment_breakdown.find(
    (s) => s.sentiment === "positive",
  )?.n ?? 0;
  const bear = stats?.sentiment_breakdown.find(
    (s) => s.sentiment === "negative",
  )?.n ?? 0;
  const top = stats?.event_type_breakdown[0];
  const senti = bull + bear;

  const lastMs = stats?.last_run
    ? stats.last_run.finished_at ?? stats.last_run.started_at
    : null;
  // Strip the cost= segment from the summary line — that's an
  // operator/audit detail, not something users need to see.
  const summary = stats?.last_run?.summary
    ? stats.last_run.summary.replace(/\s*cost=\$[\d.]+/g, "").trim()
    : null;

  return (
    <div className="flex flex-col gap-6">
      {/* Headline: 24h event throughput — the number the page is about. */}
      <HeroStat
        label="Events 24h"
        value={stats ? stats.events_24h.toLocaleString() : "—"}
        sub={stats ? `${stats.total_events.toLocaleString()} total ingested` : undefined}
      />

      {/* Supporting stats — classification progress + sentiment balance. */}
      <div className="grid grid-cols-1 gap-x-10 sm:grid-cols-2 md:max-w-[560px]">
        <Stat
          label="Classified"
          value={stats?.total_classified ?? "—"}
          sub={stats ? `${stats.unclassified} pending` : undefined}
          tone="accent"
        />
        <Stat
          label="Sentiment 24h"
          value={
            <span className="inline-flex items-baseline gap-2">
              <Num value={bull} tier="lead" tone="positive" />
              <span className="text-[13px] text-fg-dim">vs</span>
              <Num value={bear} tier="lead" tone="negative" />
            </span>
          }
          // Diverging bull/bear split bar — the sentiment balance read as
          // length rather than "value + sub". Homogeneous event counts.
          sub={
            senti > 0 ? (
              <div
                className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full"
                role="img"
                aria-label={`${bull} bullish vs ${bear} bearish events (24h)`}
              >
                <div
                  className="bg-positive/70"
                  style={{ width: `${(bull / senti) * 100}%` }}
                />
                <div
                  className="bg-negative/70"
                  style={{ width: `${(bear / senti) * 100}%` }}
                />
              </div>
            ) : undefined
          }
        />
      </div>

      {/* Context — categorical top type + last-ingest timestamp, demoted to a caption line. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[11.5px] text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="font-[var(--font-jetbrains-mono)] text-[10px] uppercase tracking-[0.14em] text-fg-dim">
            Top type
          </span>
          {top ? (
            <span>
              {top.event_type} <span className="text-fg-dim">· {top.n}</span>
            </span>
          ) : (
            <span className="text-fg-dim">—</span>
          )}
        </span>
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="font-[var(--font-jetbrains-mono)] text-[10px] uppercase tracking-[0.14em] text-fg-dim">
            Last ingest
          </span>
          {lastMs != null ? (
            <Timestamp ms={lastMs} mode="relative" />
          ) : (
            <span className="text-fg-dim">—</span>
          )}
          {summary ? <span className="text-fg-dim">— {summary}</span> : null}
        </span>
      </div>
    </div>
  );
}
