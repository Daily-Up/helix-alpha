"use client";

/**
 * EventCardCompact — one feed row: type / sentiment / severity chips, headline,
 * a 2-line clamped summary, asset pills (% move + Long/Short), source + time,
 * and a "+N related" note when duplicates were clustered. Clicking opens the
 * detail panel. Terminal design tokens throughout.
 */

import { fmtRelative } from "@/lib/format";
import { cn } from "@/components/ui/cn";
import { AssetPill } from "./AssetPill";
import type { StreamEvent } from "@/lib/events/use-stream";

const sentimentCls: Record<string, string> = {
  positive: "text-positive",
  negative: "text-negative",
  neutral: "text-fg-dim",
};

function Chips({ ev }: { ev: StreamEvent }) {
  const sev = ev.severity;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[9px] font-medium uppercase tracking-wider">
      {ev.event_type ? (
        <span className="rounded bg-[color:var(--accent-trade)]/12 px-1.5 py-px text-[color:var(--accent-trade)]">
          {ev.event_type}
        </span>
      ) : null}
      {ev.sentiment ? (
        <span
          className={cn(
            "inline-flex items-center gap-1",
            sentimentCls[ev.sentiment],
          )}
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
          {ev.sentiment}
        </span>
      ) : null}
      {sev ? (
        <span
          className={cn(
            "rounded border border-line px-1.5 py-px",
            sev === "high"
              ? "font-semibold text-fg"
              : sev === "medium"
                ? "text-fg-muted"
                : "text-fg-dim",
          )}
          title="Event severity"
        >
          {sev}
        </span>
      ) : null}
    </div>
  );
}

export function EventCardCompact({
  ev,
  onOpen,
}: {
  ev: StreamEvent;
  onOpen: (ev: StreamEvent) => void;
}) {
  return (
    <article
      onClick={() => onOpen(ev)}
      className="group cursor-pointer border-b border-line px-1 py-3 transition-colors hover:bg-surface-2/30"
    >
      <div className="mb-1.5 flex items-start justify-between gap-3">
        <Chips ev={ev} />
        <span className="shrink-0 font-[var(--font-jetbrains-mono)] text-[10px] tabular-nums text-fg-dim">
          {fmtRelative(ev.release_time)}
        </span>
      </div>

      <h3 className="mb-1 text-[14px] font-medium leading-snug text-fg group-hover:text-white">
        {ev.title}
      </h3>

      {ev.takeaway && ev.takeaway !== ev.title ? (
        <p className="mb-2 line-clamp-2 text-[12px] leading-relaxed text-fg-muted">
          {ev.takeaway}
        </p>
      ) : (
        <div className="mb-1" />
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {ev.tradable.slice(0, 4).map((a) => (
          <AssetPill key={a.id} asset={a} sentiment={ev.sentiment} />
        ))}
        {/* Non-tradable affected assets: plain ticker, no button. */}
        {ev.tradable.length === 0 && ev.assets.length > 0 ? (
          <span className="text-[11px] text-fg-dim">
            {ev.assets.slice(0, 4).map((a) => a.ticker).join(" · ")}
          </span>
        ) : null}
        {ev.related.length > 0 ? (
          <span className="rounded bg-surface-2/60 px-1.5 py-0.5 text-[10px] text-fg-muted">
            +{ev.related.length} related
          </span>
        ) : null}
        {ev.author ? (
          <span className="ml-auto font-[var(--font-jetbrains-mono)] text-[9px] uppercase tracking-wider text-fg-dim">
            {ev.author}
          </span>
        ) : null}
      </div>
    </article>
  );
}
