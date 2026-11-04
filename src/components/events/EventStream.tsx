"use client";

/**
 * EventStream — the news → trade hub. Center: For You / Equities / Crypto /
 * Macro tabs, a stats row, the "Trending now" hero carousel, classifier topic
 * tabs, and a filtered feed of clustered cards. Right rail (sticky): SoDEX
 * movers, the watchlist, and ingest status. A detail slide-over opens on any
 * card. All read-only; trade buttons deep-link into /trade with a side preset.
 */

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/components/ui/cn";
import {
  usePerpMarkets,
  useStreamEvents,
  useKlines,
  pctSince,
  type StreamEvent,
} from "@/lib/events/use-stream";
import { useWatchlist } from "@/lib/events/watchlist";
import type { MarketCategory } from "@/lib/events/market-map";
import { StatsRow } from "./StatsRow";
import { HeroCarousel } from "./HeroCarousel";
import { TopicTabs } from "./TopicTabs";
import { EventCardCompact } from "./EventCardCompact";
import { MoversRail } from "./MoversRail";
import { WatchlistRail } from "./WatchlistRail";
import { IngestStatus } from "./IngestStatus";
import { DetailPanel } from "./DetailPanel";

type CenterTab = "For You" | "Equities" | "Crypto" | "Macro";
const CENTER_TABS: CenterTab[] = ["For You", "Equities", "Crypto", "Macro"];

const MACRO_CATS = new Set<MarketCategory>(["macro", "index", "commodity"]);

export function EventStream() {
  const { perpSet, tickers, movers } = usePerpMarkets();
  const { events, loading } = useStreamEvents(perpSet);
  const { list: watchlist } = useWatchlist();

  const [tab, setTab] = useState<CenterTab>("For You");
  const [topic, setTopic] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<StreamEvent | null>(null);
  const [lastIngestMs, setLastIngestMs] = useState<number | null>(null);

  // Last-ingest freshness (real MAX(ingested_at), not the named cron).
  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch("/api/data/stats");
        if (!r.ok) return;
        const j = (await r.json()) as { last_ingest_ms?: number | null };
        setLastIngestMs(j.last_ingest_ms ?? null);
      } catch {
        /* ignore */
      }
    };
    load();
    const t = setInterval(load, 120_000);
    return () => clearInterval(t);
  }, []);

  // Klines for the hero + top feed assets → chart backgrounds + % move.
  const klineSymbols = useMemo(() => {
    const s = new Set<string>();
    for (const e of events.slice(0, 24))
      for (const a of e.tradable) if (a.sodexSymbol) s.add(a.sodexSymbol);
    return [...s];
  }, [events]);
  const klines = useKlines(klineSymbols);

  // Fill % move since event on each tradable asset.
  const priced = useMemo(
    () =>
      events.map((e) => ({
        ...e,
        tradable: e.tradable.map((a) => ({
          ...a,
          pctSinceEvent: a.sodexSymbol
            ? pctSince(klines.get(a.sodexSymbol), e.release_time)
            : null,
        })),
      })),
    [events, klines],
  );

  // Hero: high-severity, ≥70% confidence, tradable — newest 5.
  const heroes = useMemo(
    () =>
      priced
        .filter(
          (e) =>
            e.severity === "high" &&
            (e.confidence ?? 0) >= 0.7 &&
            e.tradable.length > 0,
        )
        .slice(0, 5),
    [priced],
  );
  const heroIds = useMemo(() => new Set(heroes.map((h) => h.id)), [heroes]);

  // Feed: center tab + topic + relevance filter, heroes excluded.
  const feed = useMemo(() => {
    const watchSet = new Set(watchlist);
    return priced.filter((e) => {
      if (heroIds.has(e.id)) return false;
      if (topic && e.event_type !== topic) return false;
      if (tab === "Equities" && e.category !== "equity") return false;
      if (tab === "Crypto" && e.category !== "crypto") return false;
      if (tab === "Macro" && !MACRO_CATS.has(e.category)) return false;
      if (tab === "For You") {
        const onWatch = e.tradable.some(
          (a) => a.sodexSymbol && watchSet.has(a.sodexSymbol),
        );
        if (!onWatch && e.severity !== "high") return false;
      }
      return true;
    });
  }, [priced, tab, topic, heroIds, watchlist]);

  const isRelevant = (e: StreamEvent) =>
    e.assets.length > 0 && (e.confidence ?? 0) >= 0.5;
  const shown = showAll ? feed : feed.filter(isRelevant);
  const hiddenCount = feed.length - feed.filter(isRelevant).length;

  return (
    <div className="trade-terminal flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold text-fg">Event Stream</h1>
          <p className="text-[12.5px] text-fg-muted">
            AI-classified market news, mapped to SoDEX markets — read the signal,
            trade it.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        {/* ── Center ── */}
        <div className="flex min-w-0 flex-col gap-4">
          {/* Center tabs */}
          <div className="flex items-center gap-4 overflow-x-auto border-b border-line pb-px text-[13px]">
            {CENTER_TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "relative whitespace-nowrap pb-2 font-medium transition-colors",
                  tab === t ? "text-fg" : "text-fg-dim hover:text-fg-muted",
                )}
              >
                {t}
                <span
                  aria-hidden
                  className="absolute inset-x-0 -bottom-px h-[2px] rounded-full transition-opacity"
                  style={{
                    background: "var(--accent-trade)",
                    opacity: tab === t ? 1 : 0,
                  }}
                />
              </button>
            ))}
          </div>

          <StatsRow events={priced} lastIngestMs={lastIngestMs} />

          {heroes.length > 0 ? (
            <HeroCarousel heroes={heroes} klines={klines} onOpen={setSelected} />
          ) : null}

          <TopicTabs events={priced} value={topic} onChange={setTopic} />

          {/* Feed */}
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-fg-dim">
              {loading && priced.length === 0
                ? "Loading…"
                : `${shown.length} event${shown.length === 1 ? "" : "s"}`}
            </span>
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-fg-muted">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
                className="h-3 w-3 accent-[color:var(--accent-trade)]"
              />
              Show all (incl. low-relevance)
              {hiddenCount > 0 ? ` · ${hiddenCount}` : ""}
            </label>
          </div>

          <div className="flex flex-col">
            {shown.length === 0 && !loading ? (
              <div className="py-12 text-center text-[13px] text-fg-dim">
                No events match this view yet.
              </div>
            ) : (
              shown.map((e) => (
                <div
                  key={e.id}
                  className={cn(!isRelevant(e) && showAll && "opacity-55")}
                >
                  <EventCardCompact ev={e} onOpen={setSelected} />
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── Right rail ── */}
        <aside className="flex flex-col gap-4 xl:sticky xl:top-4 xl:h-fit">
          <MoversRail movers={movers} />
          <WatchlistRail tickers={tickers} />
          <IngestStatus lastIngestMs={lastIngestMs} />
        </aside>
      </div>

      <DetailPanel
        ev={selected}
        klines={klines}
        onClose={() => setSelected(null)}
        onOpen={setSelected}
      />
    </div>
  );
}
