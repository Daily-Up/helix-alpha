"use client";

/**
 * MoversRail — "Trending on SoDEX": the top 5 movers by 24h % among perps,
 * split into Equities / Crypto tabs. Each row links into /trade on that market;
 * a star adds it to the watchlist.
 */

import Link from "next/link";
import { useState } from "react";
import { AssetLogo } from "@/components/ui/AssetLogo";
import { cn } from "@/components/ui/cn";
import { tradeHref, useWatchlist } from "@/lib/events/watchlist";
import { perpDisplay } from "@/lib/events/market-map";
import type { Mover } from "@/lib/events/use-stream";

const fmtPx = (v: number) =>
  v >= 1000
    ? v.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : v >= 1
      ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : v.toLocaleString(undefined, { maximumFractionDigits: 6 });

export function MoverRow({ m }: { m: Mover }) {
  const watch = useWatchlist();
  const up = m.changePct >= 0;
  return (
    <div className="group flex items-center gap-2 py-1.5">
      <button
        onClick={() => watch.toggle(m.symbol)}
        className={cn(
          "text-[12px] leading-none transition-colors",
          watch.has(m.symbol)
            ? "text-[color:var(--accent-trade)]"
            : "text-fg-dim hover:text-fg-muted",
        )}
        title={watch.has(m.symbol) ? "Unstar" : "Add to watchlist"}
      >
        {watch.has(m.symbol) ? "★" : "☆"}
      </button>
      <Link
        href={tradeHref(m.symbol)}
        className="flex min-w-0 flex-1 items-center gap-2"
      >
        <AssetLogo symbol={m.ticker} size={20} />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[12px] font-medium text-fg">
            {m.ticker}
          </span>
          <span className="truncate text-[9px] uppercase tracking-wider text-fg-dim">
            {perpDisplay(m.symbol)}
          </span>
        </span>
        <span className="ml-auto flex flex-col items-end leading-tight">
          <span className="font-[var(--font-jetbrains-mono)] text-[11px] tabular-nums text-fg">
            ${fmtPx(m.last)}
          </span>
          <span
            className={cn(
              "font-[var(--font-jetbrains-mono)] text-[10px] tabular-nums",
              up ? "text-positive" : "text-negative",
            )}
          >
            {up ? "+" : "−"}
            {Math.abs(m.changePct).toFixed(2)}%
          </span>
        </span>
      </Link>
    </div>
  );
}

export function MoversRail({ movers }: { movers: Mover[] }) {
  const [tab, setTab] = useState<"equity" | "crypto">("crypto");
  const rows = movers.filter((m) => m.category === tab).slice(0, 5);

  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-fg-dim">
          Trending on SoDEX
        </span>
        <div className="flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5 text-[10px]">
          {(["crypto", "equity"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "rounded px-2 py-0.5 font-medium transition-colors",
                tab === t ? "bg-surface text-fg shadow-sm" : "text-fg-dim",
              )}
            >
              {t === "crypto" ? "Crypto" : "Equities"}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="py-3 text-center text-[11px] text-fg-dim">
          Loading movers…
        </p>
      ) : (
        <div className="divide-y divide-line/60">
          {rows.map((m) => (
            <MoverRow key={m.symbol} m={m} />
          ))}
        </div>
      )}
    </div>
  );
}
