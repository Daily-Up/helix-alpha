"use client";

/**
 * StatsRow — a compact row of four tiles that reconcile with the feed:
 *   Relevant events 24h · High severity 24h · Bullish vs Bearish · Last ingest.
 * Counts are computed from the same events the feed shows, so they always agree;
 * each tile has a tooltip defining it. Replaces the old giant "Events 24h" hero.
 */

import { fmtRelative } from "@/lib/format";
import { cn } from "@/components/ui/cn";
import type { StreamEvent } from "@/lib/events/use-stream";

const DAY = 24 * 60 * 60 * 1000;
const FRESH_MS = 20 * 60 * 1000; // green under 20 min
const DELAYED_MS = 40 * 60 * 1000; // > 2× the ~15–20 min interval

function Tile({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-line bg-surface px-3 py-2"
      title={title}
    >
      <span className="text-[9px] font-medium uppercase tracking-wider text-fg-dim">
        {label}
      </span>
      <span className="font-[var(--font-jetbrains-mono)] text-[15px] font-semibold tabular-nums text-fg">
        {children}
      </span>
    </div>
  );
}

export function StatsRow({
  events,
  lastIngestMs,
}: {
  events: StreamEvent[];
  lastIngestMs: number | null;
}) {
  const since = Date.now() - DAY;
  const last24 = events.filter((e) => e.release_time >= since);
  const relevant = last24.filter(
    (e) => e.assets.length > 0 && (e.confidence ?? 0) >= 0.5,
  ).length;
  const highSev = last24.filter((e) => e.severity === "high").length;
  const bull = last24.filter((e) => e.sentiment === "positive").length;
  const bear = last24.filter((e) => e.sentiment === "negative").length;
  const senti = bull + bear;

  const ingestAge = lastIngestMs ? Date.now() - lastIngestMs : null;
  const delayed = ingestAge != null && ingestAge > DELAYED_MS;
  const fresh = ingestAge != null && ingestAge < FRESH_MS;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Tile
        label="Relevant 24h"
        title="Classified events in the last 24h with an affected asset and ≥50% confidence — the ones shown by default."
      >
        {relevant}
      </Tile>
      <Tile
        label="High severity"
        title="Events tagged high severity in the last 24h."
      >
        {highSev}
      </Tile>
      <Tile
        label="Bull vs Bear"
        title="Positive vs negative sentiment across classified events (24h)."
      >
        <span className="inline-flex items-center gap-1.5">
          <span className="text-positive">{bull}</span>
          <span className="text-[11px] text-fg-dim">vs</span>
          <span className="text-negative">{bear}</span>
          {senti > 0 ? (
            <span className="ml-1 inline-flex h-1.5 w-10 overflow-hidden rounded-full align-middle">
              <span
                className="bg-positive/70"
                style={{ width: `${(bull / senti) * 100}%` }}
              />
              <span
                className="bg-negative/70"
                style={{ width: `${(bear / senti) * 100}%` }}
              />
            </span>
          ) : null}
        </span>
      </Tile>
      <Tile
        label="Last ingest"
        title="When the pipeline last stored a new event (actual data freshness, not the named cron)."
      >
        <span className="inline-flex items-center gap-1.5 text-[13px]">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              fresh ? "bg-positive" : "bg-[#e0a53f]",
            )}
          />
          <span className={delayed ? "text-[#e0a53f]" : "text-fg"}>
            {lastIngestMs ? fmtRelative(lastIngestMs) : "—"}
          </span>
          {delayed ? (
            <span className="text-[10px] font-normal text-[#e0a53f]">
              delayed
            </span>
          ) : null}
        </span>
      </Tile>
    </div>
  );
}
