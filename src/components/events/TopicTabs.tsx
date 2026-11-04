"use client";

/**
 * TopicTabs — classifier event-type tags as a horizontal pill row under the
 * hero. Counts come pre-computed from the CURRENT view (selected tab +
 * relevance toggle) so a chip always matches the feed; 0-count topics are
 * dropped. Clicking filters the feed; "All" clears it.
 */

import { cn } from "@/components/ui/cn";

export function TopicTabs({
  counts,
  value,
  onChange,
}: {
  counts: Map<string, number>;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const topics = [...counts.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
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
