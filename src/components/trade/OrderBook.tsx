"use client";

/**
 * OrderBook — SoDEX L2 ladder (asks on top, spread, bids below) with
 * Price / Size / Total columns and cumulative depth bars. Sits inside the
 * terminal frame. Fed by /api/sodex/market (polled in the parent).
 */

import { cn } from "@/components/ui/cn";

export interface BookLevel {
  price: string;
  size: string;
}

const n = (v: string) => Number(v);
const fmtSz = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 4 });

function Rows({
  levels,
  side,
  max,
  priceDigits,
}: {
  levels: BookLevel[];
  side: "ask" | "bid";
  max: number;
  priceDigits: number;
}) {
  const fmtPx = (v: number) =>
    v.toLocaleString(undefined, {
      minimumFractionDigits: priceDigits,
      maximumFractionDigits: priceDigits,
    });
  // asks: best (lowest) ask nearest the spread → render high→low.
  const ordered = side === "ask" ? [...levels].reverse() : levels;
  const cum = new Map<string, number>();
  let c = 0;
  for (const l of levels) {
    c += n(l.size);
    cum.set(l.price, c);
  }
  return (
    <div className="flex flex-col">
      {ordered.map((l, i) => {
        const total = cum.get(l.price) ?? 0;
        return (
          <div
            key={i}
            className="relative grid grid-cols-[1fr_1fr_1fr] px-3 py-[2.5px] font-[var(--font-jetbrains-mono)] text-[10.5px]"
          >
            <div
              className={cn(
                "absolute inset-y-0 right-0",
                side === "ask" ? "bg-negative/10" : "bg-positive/10",
              )}
              style={{ width: `${Math.min(100, (total / max) * 100)}%` }}
            />
            <span className={cn("relative", side === "ask" ? "text-negative" : "text-positive")}>
              {fmtPx(n(l.price))}
            </span>
            <span className="relative text-right text-fg-muted">{fmtSz(n(l.size))}</span>
            <span className="relative text-right text-fg-dim">{fmtSz(total)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function OrderBook({
  bids,
  asks,
  markPrice,
  loading,
  symbol,
  digits,
}: {
  bids: BookLevel[];
  asks: BookLevel[];
  markPrice: number | null;
  loading: boolean;
  symbol: string;
  digits: number;
}) {
  const bestBid = bids[0] ? n(bids[0].price) : null;
  const bestAsk = asks[0] ? n(asks[0].price) : null;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  const spreadPct = spread != null && bestBid ? (spread / bestBid) * 100 : null;
  const maxCum = Math.max(
    bids.reduce((s, l) => s + n(l.size), 0),
    asks.reduce((s, l) => s + n(l.size), 0),
    1,
  );
  const up = markPrice != null && bestBid != null ? markPrice >= bestBid : true;
  const fmtPx = (v: number) =>
    v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-[12px] font-medium text-fg">Order book</span>
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            loading ? "animate-pulse bg-accent" : "bg-fg-dim",
          )}
          title={loading ? "live" : "idle"}
        />
      </div>
      <div className="grid grid-cols-[1fr_1fr_1fr] px-3 py-1 text-[9px] uppercase tracking-wider text-fg-dim">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Total</span>
      </div>
      {asks.length === 0 && bids.length === 0 ? (
        <div className="px-3 py-10 text-center text-[11px] text-fg-dim">
          {loading ? "Loading book…" : "Book unavailable"}
        </div>
      ) : (
        <>
          <Rows levels={asks} side="ask" max={maxCum} priceDigits={digits} />
          <div className="flex items-center justify-between border-y border-line bg-surface-2/50 px-3 py-1.5">
            <span
              className={cn(
                "font-[var(--font-jetbrains-mono)] text-[13px] font-medium",
                up ? "text-positive" : "text-negative",
              )}
            >
              {markPrice != null ? fmtPx(markPrice) : "—"}
            </span>
            <span className="text-[10px] text-fg-dim">
              {spread != null
                ? `spread ${fmtPx(spread)}${spreadPct != null ? ` · ${spreadPct.toFixed(3)}%` : ""}`
                : ""}
            </span>
          </div>
          <Rows levels={bids} side="bid" max={maxCum} priceDigits={digits} />
        </>
      )}
    </div>
  );
}
