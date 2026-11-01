"use client";

/**
 * OrderPanel — full perp order ticket (TrueNorth/Arcus parity).
 *
 * Margin mode + leverage, Long/Short, Market/Limit, size with % slider,
 * TP-SL, a prominent Place Order button, an order-details block
 * (Liquidation / Order Value / Expected Price / Slippage / Fee computed
 * from size·leverage·mark) and the Perpetuals Account summary. Execution
 * reuses ExecuteLiveButton (local-key sign → SoDEX gateway → builder code
 * 8409); the Connect CTA shows until the browser is live.
 */

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { useTradeMode } from "@/lib/sodex-onchain/useTradeMode";
import { ExecuteLiveButton } from "@/components/sodex/ExecuteLiveButton";

const SIZE_MAX = 1000; // slider 0–100% → $0–$1000 notional
const TAKER_FEE = 0.0004; // SoDEX perps taker fee (0.04%)

const money = (v: number | null, d = 2) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : `$${v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;

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
  const [size, setSize] = useState<string>("50");
  const [leverage, setLeverage] = useState(isPerp ? 10 : 1);
  const [marginMode, setMarginMode] = useState<"cross" | "isolated">("cross");
  const [tpsl, setTpsl] = useState(false);

  const isLong = side === "buy";
  const sizeNum = Number(size) || 0;
  const pct = Math.min(100, Math.round((sizeNum / SIZE_MAX) * 100));
  const qty = markPrice && markPrice > 0 ? sizeNum / markPrice : null;

  // Derived order details (estimates — live account values fill in once
  // the wallet is connected).
  const orderValue = sizeNum > 0 ? sizeNum : null;
  const expectedPrice = markPrice;
  const liqPrice =
    isPerp && markPrice && sizeNum > 0 && leverage > 0
      ? isLong
        ? markPrice * (1 - 1 / leverage)
        : markPrice * (1 + 1 / leverage)
      : null;
  const feeUsd = sizeNum > 0 ? sizeNum * TAKER_FEE : null;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      {/* Margin mode + leverage */}
      {isPerp ? (
        <div className="grid grid-cols-[1fr_auto_1fr] gap-1 rounded-md border border-line p-1 text-[12px]">
          <button
            onClick={() => setMarginMode("cross")}
            className={cn(
              "rounded py-1 transition-colors",
              marginMode === "cross" ? "bg-surface-2 text-fg" : "text-fg-dim hover:text-fg",
            )}
          >
            Cross
          </button>
          <div className="relative inline-flex items-center">
            <select
              value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))}
              className="cursor-pointer appearance-none bg-transparent px-2 text-center font-medium text-fg outline-none"
            >
              {[1, 2, 3, 5, 10, 15, 20].map((l) => (
                <option key={l} value={l}>
                  {l}×
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={() => setMarginMode("isolated")}
            className={cn(
              "rounded py-1 transition-colors",
              marginMode === "isolated" ? "bg-surface-2 text-fg" : "text-fg-dim hover:text-fg",
            )}
          >
            Isolated
          </button>
        </div>
      ) : null}

      {/* Long / Short */}
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
          {isPerp ? "Long" : "Buy"}
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
          {isPerp ? "Short" : "Sell"}
        </button>
      </div>

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

      {/* Account rows */}
      <div className="flex flex-col gap-1 text-[11.5px]">
        <Row label="Available to trade" value={tm.ready ? "—" : "$0"} />
        <Row label="Current Position" value="—" tone="muted" />
      </div>

      {/* Size */}
      <label className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-fg-dim">Size</span>
          <span className="text-[10px] text-fg-dim">
            ≈ {qty != null ? qty.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"} {symbol}
          </span>
        </div>
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

      {/* TP / SL */}
      <label className="inline-flex cursor-pointer items-center gap-2 text-[11.5px] text-fg-muted">
        <input
          type="checkbox"
          checked={tpsl}
          onChange={(e) => setTpsl(e.target.checked)}
          className="h-3 w-3 accent-accent"
        />
        Take Profit / Stop Loss
      </label>

      {/* Place order */}
      <div>
        {tm.loading ? null : tm.ready ? (
          <ExecuteLiveButton
            signal={{
              signal_id: `terminal-${sodexSymbol}-${side}`,
              symbol: sodexSymbol,
              side,
              suggested_size_usd: sizeNum || 50,
              price_usd: markPrice ?? 0,
            }}
          />
        ) : (
          <Link
            href="/settings/connect-sodex"
            className={cn(
              "flex items-center justify-center rounded-md py-2.5 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90",
              isLong ? "bg-positive" : "bg-negative",
            )}
          >
            Place Order
          </Link>
        )}
        {!tm.ready && !tm.loading ? (
          <p className="mt-1.5 text-center text-[10px] text-fg-dim">
            Connect a wallet to trade · one signature, keys stay in your browser
          </p>
        ) : null}
      </div>

      {/* Order details */}
      <div className="flex flex-col gap-1.5 border-t border-line pt-3 text-[11.5px]">
        <Row label="Liquidation Price" value={liqPrice != null ? money(liqPrice, markPrice && markPrice < 10 ? 4 : 2) : "—"} />
        <Row label="Order Value" value={money(orderValue)} />
        <Row label="Expected Price" value={money(expectedPrice, markPrice && markPrice < 10 ? 4 : 2)} />
        <Row label="Slippage" value="Est. 0% / Max. 2.50%" tone="muted" />
        <Row
          label="Fee"
          value={feeUsd != null ? `${money(feeUsd, 4)} · ${(TAKER_FEE * 100).toFixed(3)}%` : `${(TAKER_FEE * 100).toFixed(3)}%`}
          tone="muted"
        />
      </div>

      {/* Perpetuals account */}
      {isPerp ? (
        <div className="flex flex-col gap-1.5 border-t border-line pt-3 text-[11.5px]">
          <div className="mb-0.5 text-[11px] font-medium text-fg">Perpetuals Account</div>
          <Row label="Perpetuals Equity" value={tm.ready ? "—" : "$0.00"} />
          <Row label="uPNL" value="—" tone="muted" />
          <Row label="Maintenance Margin" value={tm.ready ? "—" : "$0.00"} />
          <Row label="Margin Ratio" value="—" tone="muted" />
        </div>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "muted" | "positive" | "negative";
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-fg-dim">{label}</span>
      <span
        className={cn(
          "font-[var(--font-jetbrains-mono)]",
          tone === "muted" && "text-fg-muted",
          tone === "positive" && "text-positive",
          tone === "negative" && "text-negative",
          tone === "default" && "text-fg",
        )}
      >
        {value}
      </span>
    </div>
  );
}
