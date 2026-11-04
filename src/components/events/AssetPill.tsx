"use client";

/**
 * AssetPill — logo + ticker + % move since the event (with a "$X at publish →
 * $Y now" hover tooltip) + a trade button that deep-links into /trade with the
 * market selected. The button is Long/Short ONLY for a confident directional
 * read (see tradeSide); otherwise a neutral "Trade" button opens the terminal
 * with no side preset. The detail panel shows both Long + Short. Unmapped
 * assets show no button. A star toggles the asset into the watchlist.
 */

import Link from "next/link";
import { AssetLogo } from "@/components/ui/AssetLogo";
import { cn } from "@/components/ui/cn";
import { defaultSide, perpDisplay } from "@/lib/events/market-map";
import { tradeHref, useWatchlist } from "@/lib/events/watchlist";
import type { StreamAsset } from "@/lib/events/use-stream";

const pctStr = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;
const px = (v: number) =>
  `$${v.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: v < 1 ? 6 : 2,
  })}`;
const timeStr = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function TradeBtn({ symbol, side }: { symbol: string; side: "long" | "short" }) {
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
      title={`Open ${perpDisplay(symbol)} in the terminal, ${side} preset`}
    >
      {long ? "Long" : "Short"}
    </Link>
  );
}

function TradeNeutralBtn({ symbol }: { symbol: string }) {
  return (
    <Link
      href={tradeHref(symbol)}
      onClick={(e) => e.stopPropagation()}
      className="rounded bg-[color:var(--accent-trade)]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--accent-trade)] transition-colors hover:bg-[color:var(--accent-trade)]/25"
      title={`Open ${perpDisplay(symbol)} in the terminal`}
    >
      Trade
    </Link>
  );
}

export function AssetPill({
  asset,
  sentiment,
  side,
  publishMs,
  both,
  star,
}: {
  asset: StreamAsset;
  sentiment: "positive" | "negative" | "neutral" | null;
  /** Effective side for the single button; "neutral" → a no-preset Trade
   *  button. Omitted → derived from sentiment (back-compat). */
  side?: "long" | "short" | "neutral";
  /** Event publish time (ms), for the % tooltip. */
  publishMs?: number;
  /** Show both Long + Short (detail panel). */
  both?: boolean;
  /** Show a watchlist star (movers/detail). */
  star?: boolean;
}) {
  const move = asset.move;
  const pct = move?.pct ?? null;
  const watch = useWatchlist();
  const sym = asset.sodexSymbol;
  const effSide = side ?? defaultSide(sentiment);

  const moveTip =
    move && sym
      ? `${perpDisplay(sym)}: ${px(move.basePrice)} at publish${
          publishMs ? ` (${timeStr(publishMs)})` : ""
        } → ${px(move.lastPrice)} now`
      : undefined;

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
            moveTip && "cursor-help",
            pct >= 0 ? "text-positive" : "text-negative",
          )}
          title={moveTip}
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
        ) : effSide === "neutral" ? (
          <TradeNeutralBtn symbol={sym} />
        ) : (
          <TradeBtn symbol={sym} side={effSide} />
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
