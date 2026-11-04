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
import type { SodexCandle } from "@/lib/sodex/types";
import { AssetPill } from "./AssetPill";
import { Sparkline } from "./Sparkline";
import type { StreamEvent } from "@/lib/events/use-stream";

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
  onOpen,
}: {
  heroes: StreamEvent[];
  klines: Map<string, SodexCandle[]>;
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

  return (
    <div
      className="relative overflow-hidden rounded-lg border border-line bg-surface"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="relative h-[250px]">
        {/* Price chart background — lower 65%, faded. */}
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
        {/* Legibility gradient. */}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(11,14,17,0.72) 0%, rgba(11,14,17,0.35) 45%, rgba(11,14,17,0.82) 100%)",
          }}
        />

        <div className="relative flex h-full flex-col p-5">
          <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider">
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
            <h2 className="mb-1.5 max-w-[34ch] text-[19px] font-semibold leading-tight text-white">
              {ev.title}
            </h2>
            {ev.takeaway && ev.takeaway !== ev.title ? (
              <p className="mb-3 line-clamp-1 max-w-[52ch] text-[12.5px] text-fg-muted">
                {ev.takeaway}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {ev.tradable.slice(0, 3).map((a) => (
                <AssetPill key={a.id} asset={a} sentiment={ev.sentiment} />
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
              className="absolute left-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full bg-surface-2/70 text-fg-muted transition-colors hover:text-fg"
              aria-label="Previous"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => setI((p) => (p + 1) % count)}
              className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full bg-surface-2/70 text-fg-muted transition-colors hover:text-fg"
              aria-label="Next"
            >
              <ChevronRight size={16} />
            </button>
          </>
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
