"use client";

/**
 * OrderBook — SoDEX bids/asks ladder with cumulative depth bars, fed by
 * /api/sodex/market (polled in the parent). Asks on top (red), spread in
 * the middle, bids below (green) — the standard book layout.
 */

import { cn } from "@/components/ui/cn";

export interface BookLevel {
  price: string;
  size: string;
}

const n = (v: string) => Number(v);
const fmtPx = (v: number) =>
  v.toLocaleString(undefined, { maximumFractionDigits: v < 10 ? 5 : 2 });
const fmtSz = (v: number) =>
  v.toLocaleString(undefined, { maximumFractionDigits: 4 });

function Side({
  levels,
  side,
  max,
}: {
  levels: BookLevel[];
  side: "ask" | "bid";
  max: number;
}) {
  // asks render high→low (reversed) so the best ask sits next to the spread.
  const rows = side === "ask" ? [...levels].reverse() : levels;
  let cum = 0;
  // Pre-compute cumulative from the best price outward.
  const withCum =
    side === "ask"
      ? (() => {
          const base = [...levels]; // ascending by price (best first)
          const map = new Map<string, number>();
          let c = 0;
          for (const l of base) {
            c += n(l.size);
            map.set(l.price, c);
          }
          return rows.map((l) => ({ ...l, cum: map.get(l.price) ?? 0 }));
        })()
      : rows.map((l) => {
          cum += n(l.size);
          return { ...l, cum };
        });

  return (
    <div className="flex flex-col">
      {withCum.map((l, i) => (
        <div key={i} className="relative flex justify-between px-2 py-[2px] text-[11px]">
          <div
            className={cn(
              "absolute inset-y-0 right-0",
              side === "ask" ? "bg-negative/10" : "bg-positive/10",
            )}
            style={{ width: `${Math.min(100, (l.cum / max) * 100)}%` }}
          />
          <span
            className={cn(
              "relative font-[var(--font-jetbrains-mono)]",
              side === "ask" ? "text-negative" : "text-positive",
            )}
          >
            {fmtPx(n(l.price))}
          </span>
          <span className="relative font-[var(--font-jetbrains-mono)] text-fg-muted">
            {fmtSz(n(l.size))}
          </span>
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
}: {
  bids: BookLevel[];
  asks: BookLevel[];
  markPrice: number | null;
  loading: boolean;
}) {
  const bestBid = bids[0] ? n(bids[0].price) : null;
  const bestAsk = asks[0] ? n(asks[0].price) : null;
  const spread =
    bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  const spreadPct =
    spread != null && bestBid ? (spread / bestBid) * 100 : null;

  const maxCum = Math.max(
    bids.reduce((s, l) => s + n(l.size), 0),
    asks.reduce((s, l) => s + n(l.size), 0),
    1,
  );

  return (
    <div className="flex flex-col rounded-xl border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-[12px] font-medium text-fg">Order book</span>
        {loading ? <span className="text-[10px] text-fg-dim">live…</span> : null}
      </div>
      <div className="flex justify-between px-2 py-1 font-[var(--font-jetbrains-mono)] text-[9px] uppercase tracking-wider text-fg-dim">
        <span>Price</span>
        <span>Size</span>
      </div>
      {asks.length === 0 && bids.length === 0 ? (
        <div className="px-3 py-8 text-center text-[11px] text-fg-dim">
          {loading ? "Loading book…" : "Book unavailable"}
        </div>
      ) : (
        <>
          <Side levels={asks} side="ask" max={maxCum} />
          <div className="flex items-center justify-between border-y border-line bg-surface-2 px-2 py-1">
            <span className="font-[var(--font-jetbrains-mono)] text-[12px] text-fg">
              {markPrice != null ? fmtPx(markPrice) : "—"}
            </span>
            <span className="text-[10px] text-fg-dim">
              {spread != null
                ? `${fmtPx(spread)}${spreadPct != null ? ` · ${spreadPct.toFixed(3)}%` : ""}`
                : ""}
            </span>
          </div>
          <Side levels={bids} side="bid" max={maxCum} />
        </>
      )}
    </div>
  );
}
