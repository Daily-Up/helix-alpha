"use client";

/**
 * OrderBook — SoDEX L2 ladder (asks on top, spread, bids below) with
 * cumulative depth bars. Sits inside the terminal frame, so no outer
 * border of its own. Fed by /api/sodex/market (polled in the parent).
 */

import { cn } from "@/components/ui/cn";

export interface BookLevel {
  price: string;
  size: string;
}

const n = (v: string) => Number(v);
const fmtPx = (v: number) =>
  v.toLocaleString(undefined, {
    minimumFractionDigits: v < 10 ? 4 : 2,
    maximumFractionDigits: v < 10 ? 4 : 2,
  });
const fmtSz = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 4 });

function Rows({
  levels,
  side,
  max,
}: {
  levels: BookLevel[];
  side: "ask" | "bid";
  max: number;
}) {
  // asks: best (lowest) ask nearest the spread → render high→low.
  const ordered = side === "ask" ? [...levels].reverse() : levels;
  // cumulative from the best price outward
  const cum = new Map<string, number>();
  let c = 0;
  for (const l of levels) {
    c += n(l.size);
    cum.set(l.price, c);
  }
  return (
    <div className="flex flex-col">
      {ordered.map((l, i) => (
        <div
          key={i}
          className="relative flex justify-between px-3 py-[2.5px] font-[var(--font-jetbrains-mono)] text-[11px]"
        >
          <div
            className={cn(
              "absolute inset-y-0 right-0",
              side === "ask" ? "bg-negative/10" : "bg-positive/10",
            )}
            style={{ width: `${Math.min(100, ((cum.get(l.price) ?? 0) / max) * 100)}%` }}
          />
          <span className={cn("relative", side === "ask" ? "text-negative" : "text-positive")}>
            {fmtPx(n(l.price))}
          </span>
          <span className="relative text-fg-muted">{fmtSz(n(l.size))}</span>
        </div>
      ))}
    </div>
  );
}

export function OrderBook({
  bids,
  asks,
  markPrice,
  loading,
  symbol,
}: {
  bids: BookLevel[];
  asks: BookLevel[];
  markPrice: number | null;
  loading: boolean;
  symbol: string;
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
      <div className="flex justify-between px-3 py-1 text-[9px] uppercase tracking-wider text-fg-dim">
        <span>Price</span>
        <span>Size ({symbol})</span>
      </div>
      {asks.length === 0 && bids.length === 0 ? (
        <div className="px-3 py-10 text-center text-[11px] text-fg-dim">
          {loading ? "Loading book…" : "Book unavailable"}
        </div>
      ) : (
        <>
          <Rows levels={asks} side="ask" max={maxCum} />
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
          <Rows levels={bids} side="bid" max={maxCum} />
        </>
      )}
    </div>
  );
}
