"use client";

/**
 * EventStream — the news → trade hub. Center: All / Equities / Crypto / Macro
 * tabs, a stats row, the "Trending now" hero carousel, classifier topic tabs,
 * and a filtered feed of clustered cards. Right rail (sticky): SoDEX movers,
 * the watchlist, and ingest status. A detail slide-over opens on any card. All
 * read-only; trade buttons deep-link into /trade with a side preset.
 *
 * Every filter stays consistent with what is shown: the hero, the topic-chip
 * counts and the feed are all computed from the SAME pool — the selected tab,
 * with the relevance toggle applied — so a chip always returns exactly its
 * count and a tab with no hero-worthy events simply has no hero.
 */

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/components/ui/cn";
import {
  usePerpMarkets,
  useStreamEvents,
  useKlines,
  useHeroImages,
  pctSince,
  type StreamEvent,
} from "@/lib/events/use-stream";
import type { MarketCategory } from "@/lib/events/market-map";
import { StatsRow } from "./StatsRow";
import { HeroCarousel } from "./HeroCarousel";
import { TopicTabs } from "./TopicTabs";
import { EventCardCompact } from "./EventCardCompact";
import { MoversRail } from "./MoversRail";
import { WatchlistRail } from "./WatchlistRail";
import { IngestStatus } from "./IngestStatus";
import { DetailPanel } from "./DetailPanel";

type CenterTab = "All" | "Equities" | "Crypto" | "Macro";
const CENTER_TABS: CenterTab[] = ["All", "Equities", "Crypto", "Macro"];

const MACRO_CATS = new Set<MarketCategory>(["macro", "index", "commodity"]);

/** Which center tab an event belongs to (by its dominant market category). */
function matchesTab(e: StreamEvent, tab: CenterTab): boolean {
  if (tab === "All") return true;
  if (tab === "Equities") return e.category === "equity";
  if (tab === "Crypto") return e.category === "crypto";
  return MACRO_CATS.has(e.category); // Macro
}

/** Feed-worthy: maps to at least one asset and the classifier is ≥50% sure. */
const isRelevant = (e: StreamEvent) =>
  e.assets.length > 0 && (e.confidence ?? 0) >= 0.5;

export function EventStream() {
  const { perpSet, tickers, movers } = usePerpMarkets();
  const { events, loading } = useStreamEvents(perpSet);

  const [tab, setTab] = useState<CenterTab>("All");
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

  // Hero: high-severity, ≥70% confidence, tradable — newest 5 WITHIN the tab,
  // so Equities shows only equity heroes, etc. An empty list hides the hero.
  const heroes = useMemo(
    () =>
      priced
        .filter(
          (e) =>
            e.severity === "high" &&
            (e.confidence ?? 0) >= 0.7 &&
            e.tradable.length > 0 &&
            matchesTab(e, tab),
        )
        .slice(0, 5),
    [priced, tab],
  );
  const heroIds = useMemo(() => new Set(heroes.map((h) => h.id)), [heroes]);
  const heroImages = useHeroImages(heroes);

  // The single pool everything downstream reads: the selected tab, heroes
  // removed, relevance toggle applied — but NOT the topic filter. Topic-chip
  // counts and the feed both derive from this, so a chip always returns
  // exactly its count.
  const viewPool = useMemo(
    () =>
      priced.filter(
        (e) =>
          !heroIds.has(e.id) &&
          matchesTab(e, tab) &&
          (showAll || isRelevant(e)),
      ),
    [priced, tab, showAll, heroIds],
  );

  // Topic-chip counts over the current view (0-count topics are dropped in
  // TopicTabs, which only renders keys present here).
  const topicCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of viewPool)
      if (e.event_type) m.set(e.event_type, (m.get(e.event_type) ?? 0) + 1);
    return m;
  }, [viewPool]);

  // Selected topic no longer present in this view (e.g. after a tab switch) →
  // clear it so the feed doesn't go silently empty.
  useEffect(() => {
    if (topic && !topicCounts.has(topic)) setTopic(null);
  }, [topic, topicCounts]);

  // Feed = the view pool, narrowed to the selected topic. shown.length when a
  // topic is active == that chip's count, by construction.
  const shown = useMemo(
    () => (topic ? viewPool.filter((e) => e.event_type === topic) : viewPool),
    [viewPool, topic],
  );

  // How many low-relevance events the toggle is hiding in this exact view.
  const hiddenCount = useMemo(() => {
    if (showAll) return 0;
    return priced.filter(
      (e) =>
        !heroIds.has(e.id) &&
        matchesTab(e, tab) &&
        (!topic || e.event_type === topic) &&
        !isRelevant(e),
    ).length;
  }, [priced, tab, topic, heroIds, showAll]);

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
            <HeroCarousel
              heroes={heroes}
              klines={klines}
              images={heroImages}
              onOpen={setSelected}
            />
          ) : null}

          <TopicTabs counts={topicCounts} value={topic} onChange={setTopic} />

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
