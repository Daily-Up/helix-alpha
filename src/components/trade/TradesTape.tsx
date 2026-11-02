"use client";

/**
 * TradesTape — recent public trades for the terminal's "Trades" tab.
 * Price coloured by side, size, HH:MM:SS time; newest on top. Rows are
 * memoized so only changed rows re-render.
 */

import { memo } from "react";

export interface Trade {
  id: number;
  time: number;
  side: "BUY" | "SELL";
  price: string;
  size: string;
}

const two = (n: number) => String(n).padStart(2, "0");
const fmtTime = (ms: number) => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

const TradeRow = memo(function TradeRow({
  t,
  digits,
}: {
  t: Trade;
  digits: number;
}) {
  const buy = t.side === "BUY";
  return (
    <div className="grid grid-cols-[1fr_1fr_1fr] px-3 py-[2.5px] font-[var(--font-jetbrains-mono)] text-[10.5px] tabular-nums">
      <span className={buy ? "text-positive" : "text-negative"}>
        {Number(t.price).toLocaleString(undefined, {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })}
      </span>
      <span className="text-right text-fg-muted">
        {Number(t.size).toLocaleString(undefined, { maximumFractionDigits: 4 })}
      </span>
      <span className="text-right text-fg-dim">{fmtTime(t.time)}</span>
    </div>
  );
});

export function TradesTape({
  trades,
  digits,
  loading,
}: {
  trades: Trade[];
  digits: number;
  loading: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-[1fr_1fr_1fr] px-3 py-1 text-[9px] uppercase tracking-wider text-fg-dim">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Time</span>
      </div>
      {trades.length === 0 ? (
        <div className="px-3 py-10 text-center text-[11px] text-fg-dim">
          {loading ? "Loading trades…" : "No recent trades"}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {trades.map((t) => (
            <TradeRow key={t.id} t={t} digits={digits} />
          ))}
        </div>
      )}
    </div>
  );
}
