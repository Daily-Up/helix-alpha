"use client";

/**
 * HeroCarousel — "Trending now": top high-severity, high-confidence events with
 * a SoDEX-tradable asset. Each card uses the main asset's 1D price chart as a
 * faded background (with an event-time marker), a category glyph, the headline,
 * a one-line takeaway, a "Read the analysis →" link, and asset pills. Auto-
 * advances every 8s, pauses on hover; dots + arrows for manual control. No news
 * photos or images of people — the price is the visual.
 */

import { useEffect, useRef, useState } from "react";
import {
  BarChart3,
  ShieldAlert,
  Scale,
  Globe,
  Handshake,
  Vote,
  Landmark,
  TrendingUp,
  Newspaper,
  ChevronLeft,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/components/ui/cn";
import type { SodexCandle } from "@/lib/sodex/types";
import { tradeSide } from "@/lib/events/market-map";
import { AssetPill } from "./AssetPill";
import { Sparkline } from "./Sparkline";
import type { StreamEvent, HeroImage } from "@/lib/events/use-stream";

const GLYPH: Record<string, LucideIcon> = {
  earnings: BarChart3,
  exploit: ShieldAlert,
  regulatory: Scale,
  macro: Globe,
  partnership: Handshake,
  governance: Vote,
  treasury: Landmark,
  narrative: TrendingUp,
};

export function HeroCarousel({
  heroes,
  klines,
  images,
  onOpen,
}: {
  heroes: StreamEvent[];
  klines: Map<string, SodexCandle[]>;
  /** eventId → Unsplash hero photo (or null to fall back to the chart). */
  images: Map<string, HeroImage | null>;
  onOpen: (ev: StreamEvent) => void;
}) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = heroes.length;
  const idxRef = useRef(i);
  idxRef.current = i;

  useEffect(() => {
    if (count <= 1 || paused) return;
    const t = setInterval(() => setI((p) => (p + 1) % count), 8000);
    return () => clearInterval(t);
  }, [count, paused]);

  useEffect(() => {
    if (i >= count && count > 0) setI(0);
  }, [i, count]);

  if (count === 0) return null;
  const ev = heroes[Math.min(i, count - 1)];
  const main = ev.tradable[0];
  const candles = main?.sodexSymbol ? klines.get(main.sodexSymbol) : undefined;
  const Glyph = (ev.event_type && GLYPH[ev.event_type]) || Newspaper;
  const up = ev.sentiment !== "negative";
  const img = images.get(ev.id) ?? null;

  return (
    <div
      className="relative overflow-hidden rounded-lg border border-line bg-surface"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="relative h-[250px]">
        {img ? (
          <>
            {/* Photo — right ~46% of the card (hotlinked from Unsplash). */}
            <div
              aria-hidden
              className="absolute inset-y-0 right-0 w-[46%] bg-cover bg-center"
              style={{ backgroundImage: `url("${img.url}")` }}
            />
            {/* Fade the photo into the dark left side (no hard seam). */}
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                background:
                  "linear-gradient(90deg, #0b0e11 0%, #0b0e11 46%, rgba(11,14,17,0.55) 66%, rgba(11,14,17,0) 90%)",
              }}
            />
            {/* Faded price chart kept as a subtle layer at the bottom. */}
            {candles && candles.length > 1 ? (
              <div className="absolute inset-x-0 bottom-0 h-[42%] opacity-25">
                <Sparkline
                  candles={candles}
                  eventMs={ev.release_time}
                  up={up}
                  faded
                  className="h-full w-full"
                />
              </div>
            ) : null}
            {/* Top/bottom legibility over the whole card. */}
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                background:
                  "linear-gradient(180deg, rgba(11,14,17,0.5) 0%, rgba(11,14,17,0.08) 42%, rgba(11,14,17,0.72) 100%)",
              }}
            />
          </>
        ) : (
          <>
            {/* Chart-only fallback — price chart lower 65%, faded. */}
            {candles && candles.length > 1 ? (
              <div className="absolute inset-x-0 bottom-0 h-[65%] opacity-70">
                <Sparkline
                  candles={candles}
                  eventMs={ev.release_time}
                  up={up}
                  faded
                  className="h-full w-full"
                />
              </div>
            ) : null}
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                background:
                  "linear-gradient(180deg, rgba(11,14,17,0.72) 0%, rgba(11,14,17,0.35) 45%, rgba(11,14,17,0.82) 100%)",
              }}
            />
          </>
        )}

        {/* Content insets left/right so the edge arrows never sit under it. */}
        <div className="relative flex h-full flex-col px-12 py-5">
          <div
            className={cn(
              "flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider",
              img && "max-w-[55%]",
            )}
          >
            <span className="grid h-6 w-6 place-items-center rounded-md bg-surface-2/70 text-[color:var(--accent-trade)]">
              <Glyph size={13} />
            </span>
            <span className="text-[color:var(--accent-trade)]">
              {ev.event_type ?? "news"}
            </span>
            {ev.severity ? (
              <span className="rounded border border-line px-1.5 py-px font-semibold text-fg">
                {ev.severity}
              </span>
            ) : null}
            <span className="ml-auto font-[var(--font-jetbrains-mono)] text-[10px] tabular-nums text-fg-muted">
              {ev.confidence != null
                ? `${Math.round(ev.confidence * 100)}% conf`
                : ""}
            </span>
          </div>

          <div className="mt-auto">
            <h2 className="mb-1.5 line-clamp-3 max-w-[55%] text-[19px] font-semibold leading-tight text-white">
              {ev.title}
            </h2>
            {ev.takeaway && ev.takeaway !== ev.title ? (
              <p className="mb-3 line-clamp-2 max-w-[55%] text-[12.5px] text-fg-muted">
                {ev.takeaway}
              </p>
            ) : null}
            <div
              className={cn(
                "flex flex-wrap items-center gap-2",
                img && "max-w-[55%]",
              )}
            >
              {ev.tradable.slice(0, 3).map((a) => (
                <AssetPill
                  key={a.id}
                  asset={a}
                  sentiment={ev.sentiment}
                  side={tradeSide(ev.sentiment, ev.confidence)}
                  publishMs={ev.release_time}
                />
              ))}
              <button
                onClick={() => onOpen(ev)}
                className="ml-auto rounded-md border border-[color:var(--accent-trade)]/40 bg-[color:var(--accent-trade)]/10 px-3 py-1 text-[11px] font-medium text-[color:var(--accent-trade)] transition-colors hover:bg-[color:var(--accent-trade)]/20"
              >
                Read the analysis →
              </button>
            </div>
          </div>
        </div>

        {/* Arrows */}
        {count > 1 ? (
          <>
            <button
              onClick={() => setI((p) => (p - 1 + count) % count)}
              className="absolute left-2 top-1/2 z-20 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full bg-surface-2/80 text-fg-muted shadow-md ring-1 ring-black/20 backdrop-blur-sm transition-colors hover:text-fg"
              aria-label="Previous"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => setI((p) => (p + 1) % count)}
              className="absolute right-2 top-1/2 z-20 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full bg-surface-2/80 text-fg-muted shadow-md ring-1 ring-black/20 backdrop-blur-sm transition-colors hover:text-fg"
              aria-label="Next"
            >
              <ChevronRight size={16} />
            </button>
          </>
        ) : null}

        {/* Unsplash attribution (required) — small, bottom-right over the photo. */}
        {img ? (
          <div className="absolute bottom-1 right-2.5 z-20 text-[9px] leading-none text-white/55">
            Photo by{" "}
            <a
              href={img.photographer_url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-white/30 underline-offset-2 hover:text-white/85"
            >
              {img.photographer}
            </a>{" "}
            on{" "}
            <a
              href="https://unsplash.com/?utm_source=helix&utm_medium=referral"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-white/30 underline-offset-2 hover:text-white/85"
            >
              Unsplash
            </a>
          </div>
        ) : null}
      </div>

      {/* Dots */}
      {count > 1 ? (
        <div className="flex items-center justify-center gap-1.5 border-t border-line py-2">
          {heroes.map((_, k) => (
            <button
              key={k}
              onClick={() => setI(k)}
              className="h-1.5 rounded-full transition-all"
              style={{
                width: k === i ? 16 : 6,
                background:
                  k === i ? "var(--accent-trade)" : "rgba(230,232,235,0.25)",
              }}
              aria-label={`Go to slide ${k + 1}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
