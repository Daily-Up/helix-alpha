"use client";

/**
 * TopicTabs — classifier event-type tags that have events in the last 24h,
 * as a horizontal pill row under the hero. Clicking filters the feed; "All"
 * clears it.
 */

import { cn } from "@/components/ui/cn";
import type { StreamEvent } from "@/lib/events/use-stream";

const DAY = 24 * 60 * 60 * 1000;

export function TopicTabs({
  events,
  value,
  onChange,
}: {
  events: StreamEvent[];
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const since = Date.now() - DAY;
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.release_time < since || !e.event_type) continue;
    counts.set(e.event_type, (counts.get(e.event_type) ?? 0) + 1);
  }
  const topics = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (topics.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Pill active={value == null} onClick={() => onChange(null)}>
        All
      </Pill>
      {topics.map(([t, n]) => (
        <Pill key={t} active={value === t} onClick={() => onChange(t)}>
          {t} <span className="opacity-60">{n}</span>
        </Pill>
      ))}
    </div>
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
        active
          ? "border-[color:var(--accent-trade)]/50 bg-[color:var(--accent-trade)]/12 text-[color:var(--accent-trade)]"
          : "border-line text-fg-muted hover:border-line-2 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
