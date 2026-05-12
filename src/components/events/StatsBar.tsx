"use client";

import { useEffect, useState } from "react";
import { Stat } from "@/components/ui/Stat";
import { fmtRelative } from "@/lib/format";

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

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      <Stat
        label="Events 24h"
        value={stats?.events_24h ?? "—"}
        sub={stats ? `${stats.total_events} total` : undefined}
      />
      <Stat
        label="Classified"
        value={stats?.total_classified ?? "—"}
        sub={stats ? `${stats.unclassified} pending` : undefined}
        tone="accent"
      />
      <Stat
        label="Bullish (24h)"
        value={bull}
        sub={`${bear} bearish`}
        tone="positive"
      />
      <Stat
        label="Top event type"
        value={top ? top.event_type : "—"}
        sub={top ? `${top.n} events 24h` : undefined}
      />
      <Stat
        label="Last ingest"
        value={
          stats?.last_run
            ? fmtRelative(stats.last_run.finished_at ?? stats.last_run.started_at)
            : "—"
        }
        // Strip the cost= segment from the summary line — that's an
        // operator/audit detail, not something users need to see.
        sub={
          stats?.last_run?.summary
            ? stats.last_run.summary
                .replace(/\s*cost=\$[\d.]+/g, "")
                .trim()
            : undefined
        }
      />
    </div>
  );
}
