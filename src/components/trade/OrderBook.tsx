"use client";

/**
 * OrderBook — SoDEX L2 ladder with a fixed, vertically-centered mid row and
 * a Trades tab. Equal ask/bid row counts keep the mid row from jumping on
 * updates. Price grouping aggregates sizes/totals per bucket; depth bars
 * track cumulative total from the mid outward. Clicking a price row fills the
 * ticket's limit price. Rows are memoized so only changed rows re-render.
 * Data source is unchanged (REST via /api/sodex/market, polled in the parent).
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { TradesTape, type Trade } from "./TradesTape";

export interface BookLevel {
  price: string;
  size: string;
}

const ROWS = 8; // rows per side — fixed so the mid row never moves

type Agg = { price: number; size: number; total: number };

/** Aggregate raw levels into `group`-sized buckets, nearest-mid first. */
function aggregate(
  levels: BookLevel[],
  group: number,
  side: "ask" | "bid",
): { price: number; size: number }[] {
  const m = new Map<number, number>();
  for (const l of levels) {
    const p = Number(l.price);
    const sz = Number(l.size);
    if (!Number.isFinite(p) || !Number.isFinite(sz)) continue;
    const bucket =
      group > 0
        ? side === "bid"
          ? Math.floor(p / group) * group
          : Math.ceil(p / group) * group
        : p;
    m.set(bucket, (m.get(bucket) ?? 0) + sz);
  }
  const arr = [...m.entries()].map(([price, size]) => ({ price, size }));
  // Nearest-mid first: asks ascending, bids descending.
  arr.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  return arr;
}

/** Take N nearest-mid buckets and attach cumulative totals (from mid out). */
function withCumulative(rows: { price: number; size: number }[]): Agg[] {
  let c = 0;
  return rows.slice(0, ROWS).map((r) => {
    c += r.size;
    return { ...r, total: c };
  });
}

const BookRow = memo(function BookRow({
  row,
  side,
  max,
  digits,
  onClick,
}: {
  row: Agg | null;
  side: "ask" | "bid";
  max: number;
  digits: number;
  onClick: (price: number) => void;
}) {
  if (!row) {
    // Empty placeholder keeps the column height fixed.
    return <div className="px-3 py-[2.5px] text-[10.5px]">&nbsp;</div>;
  }
  const pct = Math.min(100, (row.total / max) * 100);
  return (
    <button
      onClick={() => onClick(row.price)}
      className="relative grid w-full grid-cols-[1fr_1fr_1fr] px-3 py-[2.5px] text-left font-[var(--font-jetbrains-mono)] text-[10.5px] tabular-nums hover:bg-surface-2/60"
      title="Click to set limit price"
    >
      <div
        className={cn(
          "absolute inset-y-0 right-0",
          side === "ask" ? "bg-negative" : "bg-positive",
        )}
        style={{ width: `${pct}%`, opacity: 0.15 }}
      />
      <span
        className={cn(
          "relative",
          side === "ask" ? "text-negative" : "text-positive",
        )}
      >
        {row.price.toLocaleString(undefined, {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })}
      </span>
      <span className="relative text-right text-fg-muted">
        {row.size.toLocaleString(undefined, { maximumFractionDigits: 4 })}
      </span>
      <span className="relative text-right text-fg-dim">
        {row.total.toLocaleString(undefined, { maximumFractionDigits: 4 })}
      </span>
    </button>
  );
});

export function OrderBook({
  bids,
  asks,
  markPrice,
  loading,
  digits,
  tickSize,
  onPriceClick,
  trades,
  tradesLoading,
}: {
  bids: BookLevel[];
  asks: BookLevel[];
  markPrice: number | null;
  loading: boolean;
  digits: number;
  tickSize: number;
  onPriceClick: (price: number) => void;
  trades: Trade[];
  tradesLoading: boolean;
}) {
  const [tab, setTab] = useState<"book" | "trades">("book");

  // Grouping options are tick-size multiples (so BTC → 1/5/10/50/100).
  const tick = tickSize > 0 ? tickSize : 1;
  const groupOptions = useMemo(
    () => [1, 5, 10, 50, 100].map((m) => m * tick),
    [tick],
  );
  const [group, setGroup] = useState(groupOptions[0]);
  useEffect(() => {
    setGroup(groupOptions[0]);
  }, [groupOptions]);

  const askRows = useMemo(
    () => withCumulative(aggregate(asks, group, "ask")),
    [asks, group],
  );
  const bidRows = useMemo(
    () => withCumulative(aggregate(bids, group, "bid")),
    [bids, group],
  );
  const maxCum = Math.max(
    askRows.at(-1)?.total ?? 0,
    bidRows.at(-1)?.total ?? 0,
    1e-9,
  );

  const bestBid = bidRows[0]?.price ?? null;
  const bestAsk = askRows[0]?.price ?? null;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  const spreadPct = spread != null && bestBid ? (spread / bestBid) * 100 : null;

  // Tick direction for the mid row (vs previous mark).
  const prevMark = useRef<number | null>(null);
  const dir =
    markPrice != null && prevMark.current != null
      ? markPrice > prevMark.current
        ? "up"
        : markPrice < prevMark.current
          ? "down"
          : "same"
      : "same";
  useEffect(() => {
    if (markPrice != null) prevMark.current = markPrice;
  }, [markPrice]);

  // Pad to fixed ROWS so the mid row stays put.
  const askCells: (Agg | null)[] = Array.from(
    { length: ROWS },
    (_, i) => askRows[i] ?? null,
  ).reverse(); // best ask nearest the mid (bottom)
  const bidCells: (Agg | null)[] = Array.from(
    { length: ROWS },
    (_, i) => bidRows[i] ?? null,
  );

  const fmtPx = (v: number) =>
    v.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  const fmtGroup = (g: number) =>
    g.toLocaleString(undefined, { maximumFractionDigits: 8 });

  return (
    <div className="flex h-full flex-col">
      {/* Tabs */}
      <div className="flex items-center gap-4 border-b border-line px-3 py-2 text-[12px]">
        {(["book", "trades"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "transition-colors",
              tab === t ? "font-medium text-fg" : "text-fg-dim hover:text-fg",
            )}
          >
            {t === "book" ? "Order book" : "Trades"}
          </button>
        ))}
        <span
          className={cn(
            "ml-auto h-1.5 w-1.5 rounded-full",
            loading ? "animate-pulse bg-accent" : "bg-fg-dim",
          )}
          title={loading ? "live" : "idle"}
        />
      </div>

      {tab === "trades" ? (
        <TradesTape trades={trades} digits={digits} loading={tradesLoading} />
      ) : (
        <>
          {/* Grouping + column headers */}
          <div className="flex items-center justify-between px-3 pt-1.5">
            <span className="text-[9px] uppercase tracking-wider text-fg-dim">
              Grouping
            </span>
            <select
              value={group}
              onChange={(e) => setGroup(Number(e.target.value))}
              className="cursor-pointer rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] tabular-nums text-fg-muted outline-none"
            >
              {groupOptions.map((g) => (
                <option key={g} value={g}>
                  {fmtGroup(g)}
                </option>
              ))}
            </select>
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
            <div className="flex flex-col">
              {/* Asks (best nearest the mid, at the bottom) */}
              <div className="flex flex-col">
                {askCells.map((row, i) => (
                  <BookRow
                    key={`a${i}`}
                    row={row}
                    side="ask"
                    max={maxCum}
                    digits={digits}
                    onClick={onPriceClick}
                  />
                ))}
              </div>

              {/* Fixed mid row */}
              <div className="flex items-center justify-between border-y border-line bg-surface-2/50 px-3 py-1.5">
                <span
                  className={cn(
                    "flex items-center gap-1 font-[var(--font-jetbrains-mono)] text-[13px] font-medium tabular-nums",
                    dir === "down"
                      ? "text-negative"
                      : dir === "up"
                        ? "text-positive"
                        : "text-fg",
                  )}
                >
                  {markPrice != null ? fmtPx(markPrice) : "—"}
                  {dir === "up" || dir === "down" ? (
                    <span className="text-[10px]">
                      {dir === "down" ? "↓" : "↑"}
                    </span>
                  ) : null}
                </span>
                <span className="text-[10px] text-fg-dim">
                  {spread != null
                    ? `${fmtPx(spread)} · ${spreadPct != null ? spreadPct.toFixed(3) : "—"}%`
                    : ""}
                </span>
              </div>

              {/* Bids (best nearest the mid, at the top) */}
              <div className="flex flex-col">
                {bidCells.map((row, i) => (
                  <BookRow
                    key={`b${i}`}
                    row={row}
                    side="bid"
                    max={maxCum}
                    digits={digits}
                    onClick={onPriceClick}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
