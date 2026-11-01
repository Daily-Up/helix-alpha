"use client";

/**
 * OrderPanel — the Trade Terminal's Buy/Long–Sell/Short order ticket.
 *
 * Direction + size live here; the actual signing/placement reuses
 * ExecuteLiveButton (local-key sign → SoDEX gateway → builder code 8409),
 * so there's one audited execution path. When the browser isn't connected
 * it shows the Connect CTA instead (keyed off the shared useTradeMode).
 */

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { useTradeMode } from "@/lib/sodex-onchain/useTradeMode";
import { ExecuteLiveButton } from "@/components/sodex/ExecuteLiveButton";

export function OrderPanel({
  symbol,
  sodexSymbol,
  market,
  markPrice,
}: {
  symbol: string;
  sodexSymbol: string;
  market: "spot" | "perp" | null;
  markPrice: number | null;
}) {
  const tm = useTradeMode("mainnet");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<"market" | "limit">("market");
  const [size, setSize] = useState<string>("25");

  const isLong = side === "buy";
  const sizeNum = Number(size) || 0;

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* Buy/Long – Sell/Short */}
      <div className="grid grid-cols-2 gap-1 rounded-md border border-line p-1">
        <button
          onClick={() => setSide("buy")}
          className={cn(
            "rounded py-1.5 text-[13px] font-semibold transition-colors",
            isLong ? "bg-positive/20 text-positive" : "text-fg-muted hover:text-fg",
          )}
        >
          Buy / Long
        </button>
        <button
          onClick={() => setSide("sell")}
          className={cn(
            "rounded py-1.5 text-[13px] font-semibold transition-colors",
            !isLong ? "bg-negative/20 text-negative" : "text-fg-muted hover:text-fg",
          )}
        >
          Sell / Short
        </button>
      </div>

      {/* Market / Limit (market-only execution for now) */}
      <div className="flex items-center gap-3 text-[12px]">
        {(["market", "limit"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            disabled={t === "limit"}
            className={cn(
              "capitalize transition-colors",
              type === t ? "text-fg" : "text-fg-dim hover:text-fg-muted",
              t === "limit" && "cursor-not-allowed opacity-40",
            )}
            title={t === "limit" ? "Limit orders — coming soon" : undefined}
          >
            {t}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-fg-dim">
          Mark {markPrice != null ? markPrice.toLocaleString() : "—"}
        </span>
      </div>

      {/* Size */}
      <label className="flex flex-col gap-1">
        <span className="font-[var(--font-jetbrains-mono)] text-[10px] uppercase tracking-wider text-fg-dim">
          Size (USDC)
        </span>
        <div className="flex items-center rounded-md border border-line bg-surface-2 px-3">
          <input
            inputMode="decimal"
            value={size}
            onChange={(e) => setSize(e.target.value.replace(/[^0-9.]/g, ""))}
            className="w-full bg-transparent py-2 text-sm text-fg outline-none"
            placeholder="25"
          />
          <span className="text-[11px] text-fg-dim">USDC</span>
        </div>
      </label>
      <div className="flex gap-1">
        {[25, 50, 100, 250].map((v) => (
          <button
            key={v}
            onClick={() => setSize(String(v))}
            className="flex-1 rounded border border-line bg-surface-2 py-1 text-[11px] text-fg-muted hover:border-line-2 hover:text-fg"
          >
            ${v}
          </button>
        ))}
      </div>

      {/* Est. qty */}
      <div className="flex justify-between text-[11px] text-fg-muted">
        <span>Est. quantity</span>
        <span className="font-[var(--font-jetbrains-mono)] text-fg">
          {markPrice && markPrice > 0 && sizeNum > 0
            ? (sizeNum / markPrice).toLocaleString(undefined, {
                maximumFractionDigits: 4,
              })
            : "—"}{" "}
          {symbol}
        </span>
      </div>

      {/* Execute — reuses the audited signing + builder-code path. */}
      <div className="border-t border-line pt-3">
        {tm.loading ? null : tm.ready ? (
          <ExecuteLiveButton
            signal={{
              signal_id: `terminal-${sodexSymbol}-${side}`,
              symbol: sodexSymbol,
              side,
              suggested_size_usd: sizeNum || 25,
              price_usd: markPrice ?? 0,
            }}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <Link
              href="/settings/connect-sodex"
              className={cn(
                "inline-flex items-center justify-center gap-1.5 rounded-md border px-4 py-2.5 text-[13px] font-semibold transition-colors",
                isLong
                  ? "border-positive/40 bg-positive/15 text-positive hover:bg-positive/25"
                  : "border-negative/40 bg-negative/15 text-negative hover:bg-negative/25",
              )}
            >
              Connect SoDEX to {isLong ? "Long" : "Short"} {symbol} →
            </Link>
            <p className="text-center text-[10.5px] text-fg-dim">
              One signature · your keys never leave the browser
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
