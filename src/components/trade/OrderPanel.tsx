"use client";

/**
 * OrderPanel — the terminal order ticket (TrueNorth/Arcus style).
 *
 * Cross + leverage, Market/Limit, Buy/Long–Sell/Short, size with a %
 * slider, reduce-only / TP-SL toggles. The actual signing/placement reuses
 * ExecuteLiveButton (local-key sign → SoDEX gateway → builder code 8409),
 * so there's one audited execution path; the Connect CTA shows until live.
 */

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { useTradeMode } from "@/lib/sodex-onchain/useTradeMode";
import { ExecuteLiveButton } from "@/components/sodex/ExecuteLiveButton";

const SIZE_MAX = 500; // slider maps 0–100% onto $0–$500 notional

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
  const isPerp = market === "perp";
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<"market" | "limit">("market");
  const [size, setSize] = useState<string>("25");
  const [leverage, setLeverage] = useState(isPerp ? 10 : 1);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [tpsl, setTpsl] = useState(false);

  const isLong = side === "buy";
  const sizeNum = Number(size) || 0;
  const pct = Math.min(100, Math.round((sizeNum / SIZE_MAX) * 100));

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* Cross + leverage (perps) */}
      {isPerp ? (
        <div className="grid grid-cols-2 gap-2">
          <button className="rounded-md border border-line bg-surface-2 py-1.5 text-[12px] text-fg-muted">
            Cross
          </button>
          <div className="relative inline-flex items-center justify-center rounded-md border border-line bg-surface-2">
            <select
              value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))}
              className="w-full cursor-pointer appearance-none bg-transparent py-1.5 text-center text-[12px] font-medium text-fg outline-none"
            >
              {[1, 2, 3, 5, 10, 15, 20].map((l) => (
                <option key={l} value={l}>
                  {l}×
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      {/* Market / Limit */}
      <div className="flex items-center gap-4 text-[12px]">
        {(["market", "limit"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            disabled={t === "limit"}
            className={cn(
              "capitalize transition-colors",
              type === t ? "border-b-2 border-accent pb-0.5 font-medium text-fg" : "text-fg-dim",
              t === "limit" && "cursor-not-allowed opacity-40",
            )}
            title={t === "limit" ? "Limit orders — coming soon" : undefined}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Buy/Long – Sell/Short */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => setSide("buy")}
          className={cn(
            "rounded-md py-2 text-[13px] font-semibold transition-colors",
            isLong
              ? "bg-positive/20 text-positive ring-1 ring-positive/40"
              : "bg-surface-2 text-fg-muted hover:text-fg",
          )}
        >
          Buy / Long
        </button>
        <button
          onClick={() => setSide("sell")}
          className={cn(
            "rounded-md py-2 text-[13px] font-semibold transition-colors",
            !isLong
              ? "bg-negative/20 text-negative ring-1 ring-negative/40"
              : "bg-surface-2 text-fg-muted hover:text-fg",
          )}
        >
          Sell / Short
        </button>
      </div>

      {/* Account rows */}
      <div className="flex flex-col gap-1 border-y border-line py-2 text-[11.5px]">
        <Row label="Available to Trade" value={tm.ready ? "—" : "—"} />
        <Row label="Current Position" value="—" />
        <Row label="Mark" value={markPrice != null ? markPrice.toLocaleString() : "—"} />
      </div>

      {/* Size */}
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-fg-dim">Size</span>
        <div className="flex items-center rounded-md border border-line bg-surface-2 px-3">
          <input
            inputMode="decimal"
            value={size}
            onChange={(e) => setSize(e.target.value.replace(/[^0-9.]/g, ""))}
            className="w-full bg-transparent py-2 text-sm text-fg outline-none"
            placeholder="0"
          />
          <span className="text-[11px] text-fg-dim">USDC</span>
        </div>
      </label>
      {/* % slider */}
      <input
        type="range"
        min={0}
        max={100}
        value={pct}
        onChange={(e) => setSize(String(Math.round((Number(e.target.value) / 100) * SIZE_MAX)))}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-surface-2 accent-accent"
      />
      <div className="flex justify-between text-[10px] text-fg-dim">
        <span>0%</span>
        <span className="text-fg-muted">{pct}%</span>
        <span>100%</span>
      </div>

      {/* Est. qty */}
      <div className="flex justify-between text-[11px] text-fg-muted">
        <span>Est. quantity</span>
        <span className="font-[var(--font-jetbrains-mono)] text-fg">
          {markPrice && markPrice > 0 && sizeNum > 0
            ? (sizeNum / markPrice).toLocaleString(undefined, { maximumFractionDigits: 4 })
            : "—"}{" "}
          {symbol}
        </span>
      </div>

      {/* Toggles */}
      <div className="flex flex-col gap-1.5 text-[11.5px] text-fg-muted">
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={reduceOnly}
            onChange={(e) => setReduceOnly(e.target.checked)}
            className="h-3 w-3 accent-accent"
          />
          Reduce only
        </label>
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={tpsl}
            onChange={(e) => setTpsl(e.target.checked)}
            className="h-3 w-3 accent-accent"
          />
          Take Profit / Stop Loss
        </label>
      </div>

      {/* Execute — reuses the audited signing + builder-code path. */}
      <div className="mt-auto border-t border-line pt-3">
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
              Connect wallet to {isLong ? "Long" : "Short"} {symbol}
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-fg-dim">{label}</span>
      <span className="font-[var(--font-jetbrains-mono)] text-fg-muted">{value}</span>
    </div>
  );
}
