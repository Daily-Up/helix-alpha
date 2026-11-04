"use client";

/**
 * EventCardCompact — one feed row: type / sentiment / severity chips, headline,
 * a 2-line clamped summary, asset pills (% move + gated Long/Short/Trade),
 * source + time, and a "+N related" note when duplicates were clustered. A
 * 72×72 Unsplash thumbnail (same cache as the hero) sits on the right when the
 * event has an image; the credit is in the image's tooltip. Clicking opens the
 * detail panel.
 */

import { fmtRelative } from "@/lib/format";
import { cn } from "@/components/ui/cn";
import { tradeSide } from "@/lib/events/market-map";
import { AssetPill } from "./AssetPill";
import type { StreamEvent, HeroImage } from "@/lib/events/use-stream";

const sentimentCls: Record<string, string> = {
  positive: "text-positive",
  negative: "text-negative",
  neutral: "text-fg-dim",
};

/** A small, crop-to-square Unsplash variant of the cached hero image URL. */
function thumbUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("w", "144"); // 2× of 72 for retina
    u.searchParams.set("h", "144");
    u.searchParams.set("fit", "crop");
    u.searchParams.set("q", "72");
    return u.toString();
  } catch {
    return url;
  }
}

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
  image,
  onOpen,
}: {
  ev: StreamEvent;
  /** Cached Unsplash image for this event (same cache as the hero), or null. */
  image?: HeroImage | null;
  onOpen: (ev: StreamEvent) => void;
}) {
  const side = tradeSide(ev.sentiment, ev.confidence);
  return (
    <article
      onClick={() => onOpen(ev)}
      className="group flex cursor-pointer gap-3 border-b border-line px-1 py-3 transition-colors hover:bg-surface-2/30"
    >
      <div className="min-w-0 flex-1">
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
            <AssetPill
              key={a.id}
              asset={a}
              sentiment={ev.sentiment}
              side={side}
              publishMs={ev.release_time}
            />
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
      </div>

      {/* Category thumbnail (only when we have a cached image for this event). */}
      {image?.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbUrl(image.url)}
          alt=""
          title={`Photo by ${image.photographer} on Unsplash`}
          loading="lazy"
          className="h-[72px] w-[72px] shrink-0 self-start rounded-md object-cover ring-1 ring-line"
        />
      ) : null}
    </article>
  );
}
