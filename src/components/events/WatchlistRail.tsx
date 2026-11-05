"use client";

/**
 * WatchlistRail — markets the user has starred (localStorage), priced from the
 * live perp tickers. Star markets from the movers rail, asset pills, or the
 * terminal to populate it.
 */

import { useWatchlist } from "@/lib/events/watchlist";
import { baseCategory } from "@/lib/events/market-map";
import { MoverRow } from "./MoversRail";
import type { Mover } from "@/lib/events/use-stream";

export function WatchlistRail({
  tickers,
}: {
  tickers: Map<string, { last: number; changePct: number }>;
}) {
  const { list } = useWatchlist();

  const rows: Mover[] = list.map((symbol) => {
    const t = tickers.get(symbol);
    const base = symbol.replace(/-USDC?$/i, "");
    return {
      symbol,
      ticker: base,
      category: baseCategory(base),
      last: t?.last ?? 0,
      changePct: t?.changePct ?? 0,
      quoteVolume: 0, // not used here (watchlist rows aren't volume-filtered)
    };
  });

  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <span className="text-[11px] font-medium uppercase tracking-wider text-fg-dim">
        Watchlist
      </span>
      {rows.length === 0 ? (
        <p className="mt-2 text-[11px] leading-relaxed text-fg-dim">
          Star markets in the movers list, on an event, or in the terminal to
          see them here.
        </p>
      ) : (
        <div className="mt-1.5 divide-y divide-line/60">
          {rows.map((m) => (
            <MoverRow key={m.symbol} m={m} />
          ))}
        </div>
      )}
    </div>
  );
}
