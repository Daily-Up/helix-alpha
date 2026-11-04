"use client";

/**
 * AssetPill — logo + ticker + % move since the event + a Long/Short trade
 * button that deep-links into /trade with the market selected and the side
 * preset (no auto-size, no auto-submit). Shows one button (the sentiment
 * default) in feeds/hero, or both in the detail panel. Unmapped assets show no
 * button. A star toggles the asset into the watchlist.
 */

import Link from "next/link";
import { AssetLogo } from "@/components/ui/AssetLogo";
import { cn } from "@/components/ui/cn";
import { defaultSide } from "@/lib/events/market-map";
import { tradeHref, useWatchlist } from "@/lib/events/watchlist";
import type { StreamAsset } from "@/lib/events/use-stream";

const pctStr = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;

function TradeBtn({
  symbol,
  side,
}: {
  symbol: string;
  side: "long" | "short";
}) {
  const long = side === "long";
  return (
    <Link
      href={tradeHref(symbol, side)}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors",
        long
          ? "bg-positive/15 text-positive hover:bg-positive/25"
          : "bg-negative/15 text-negative hover:bg-negative/25",
      )}
      title={`Open ${symbol.replace(/-USDC?$/i, "-PERP")} in the terminal, ${side} preset`}
    >
      {long ? "Long" : "Short"}
    </Link>
  );
}

export function AssetPill({
  asset,
  sentiment,
  both,
  star,
}: {
  asset: StreamAsset;
  sentiment: "positive" | "negative" | "neutral" | null;
  /** Show both Long + Short (detail panel); else just the sentiment default. */
  both?: boolean;
  /** Show a watchlist star (movers/detail). */
  star?: boolean;
}) {
  const side = defaultSide(sentiment);
  const pct = asset.pctSinceEvent;
  const watch = useWatchlist();
  const sym = asset.sodexSymbol;

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2/40 px-1.5 py-0.5"
      onClick={(e) => e.stopPropagation()}
    >
      <AssetLogo symbol={asset.ticker} size={15} />
      <span className="text-[11px] font-medium text-fg">{asset.ticker}</span>
      {pct != null ? (
        <span
          className={cn(
            "font-[var(--font-jetbrains-mono)] text-[10px] tabular-nums",
            pct >= 0 ? "text-positive" : "text-negative",
          )}
        >
          {pctStr(pct)}
        </span>
      ) : null}
      {sym ? (
        both ? (
          <>
            <TradeBtn symbol={sym} side="long" />
            <TradeBtn symbol={sym} side="short" />
          </>
        ) : (
          <TradeBtn symbol={sym} side={side} />
        )
      ) : null}
      {star && sym ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            watch.toggle(sym);
          }}
          className={cn(
            "text-[11px] leading-none transition-colors",
            watch.has(sym)
              ? "text-[color:var(--accent-trade)]"
              : "text-fg-dim hover:text-fg-muted",
          )}
          title={watch.has(sym) ? "Remove from watchlist" : "Add to watchlist"}
          aria-label="Toggle watchlist"
        >
          {watch.has(sym) ? "★" : "☆"}
        </button>
      ) : null}
    </span>
  );
}
