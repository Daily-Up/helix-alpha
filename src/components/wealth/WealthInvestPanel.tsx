"use client";

/**
 * WealthInvestPanel — in-app Buy/Sell for a spot-tradable (`clob`) wealth fund.
 * MARKET IOC orders via the separate wealth spot path (placeWealthSpotOrder →
 * shared placeOrderBatch; perps code untouched). Builder fee is 0% on buys /
 * the builder rate (3 bp) on sells (SoDEX only charges spot builder fees on the
 * sell side).
 *
 * Gated behind wealthInvestEnabled(); otherwise the fund page shows the
 * "Invest on SoDEX ↗" link. Never auto-submits — the user clicks Place.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/components/ui/cn";
import { buttonClass } from "@/components/ui/Button";
import { getBuilderCode } from "@/lib/sodex-onchain/chains";
import { fmtUsd } from "@/lib/format";
import { useSodexAuth } from "@/components/sodex/auth/SodexAuthProvider";
import { fetchFeeRate, type FeeRate } from "@/lib/portfolio/fetch";
import type { SodexSymbolMeta } from "@/lib/sodex-onchain/client";
import type { WealthFundView, WealthPosition } from "@/lib/wealth/types";
import {
  placeWealthSpotOrder,
  roundDownToStep,
  spotUsdcBalance,
  wealthSymbolMeta,
  type WealthOrderResult,
} from "@/lib/wealth/spot-order";

const SODEX_TRANSFER_URL = "https://sodex.com";

function fmtDec(n: number, dp: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const s = n.toFixed(dp);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export function WealthInvestPanel({
  fund,
  holding,
  onFilled,
  tab,
  onTab,
}: {
  fund: WealthFundView;
  holding: WealthPosition | null;
  onFilled?: () => void | Promise<void>;
  /** Controlled Buy/Sell tab (so a "Sell" shortcut elsewhere can open it). */
  tab: "buy" | "sell";
  onTab: (t: "buy" | "sell") => void;
}) {
  const auth = useSodexAuth();
  const address = auth.address;
  const price = fund.price;

  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState<"usdc" | "units">("usdc");
  const [meta, setMeta] = useState<SodexSymbolMeta | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [fee, setFee] = useState<FeeRate | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WealthOrderResult | null>(null);
  // Flips true once the post-fill holdings/balance refresh has completed, so
  // the success toast stops showing "updating…".
  const [settled, setSettled] = useState(false);

  const unitsHeld = holding?.shares ?? 0;

  // Reset the entry when the tab flips (incl. from an external "Sell" shortcut).
  useEffect(() => {
    setUnit(tab === "buy" ? "usdc" : "units");
    setAmount("");
    setResult(null);
    setSettled(false);
  }, [tab]);

  // Sizing rules (once).
  useEffect(() => {
    let c = false;
    wealthSymbolMeta(fund).then((m) => !c && setMeta(m ?? null)).catch(() => {});
    return () => {
      c = true;
    };
  }, [fund]);

  // Spot balance + fee tier (per address). Returns a promise so a post-fill
  // refresh can await it before marking the order settled.
  const refreshBalance = useCallback((): Promise<void> => {
    if (!address) return Promise.resolve();
    return Promise.allSettled([
      spotUsdcBalance(address).then((b) => setBalance(b.usdc)).catch(() => setBalance(null)),
      fetchFeeRate(address, "spot").then(setFee).catch(() => {}),
    ]).then(() => undefined);
  }, [address]);
  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  const minNotional = meta?.minNotional ? Number(meta.minNotional) : 10;
  const minQuantity = meta?.minQuantity ? Number(meta.minQuantity) : 0;

  // Resolve the two sides from the single amount input.
  const calc = useMemo(() => {
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0 || !price || price <= 0) {
      return { usd: 0, units: 0 };
    }
    if (unit === "usdc") return { usd: a, units: a / price };
    return { usd: a * price, units: a };
  }, [amount, unit, price]);

  // What we send: BUY → funds (USDC), SELL → quantity (units rounded to step).
  const order = useMemo(() => {
    if (tab === "buy") {
      return { funds: fmtDec(calc.usd, 6), usd: calc.usd, units: calc.units };
    }
    const q = roundDownToStep(calc.units, meta?.stepSize);
    return { quantity: fmtDec(q, meta?.quantityPrecision ?? 8), usd: q * (price ?? 0), units: q };
  }, [tab, calc, meta, price]);

  const notEnoughUsdc = tab === "buy" && balance != null && order.usd > balance + 1e-9;
  const notEnoughUnits = tab === "sell" && order.units > unitsHeld + 1e-9;
  const belowMinNotional = order.usd > 0 && order.usd < minNotional;
  const belowMinQty = tab === "sell" && order.units > 0 && minQuantity > 0 && order.units < minQuantity;

  const err =
    !price
      ? "No live price."
      : order.usd <= 0
        ? null
        : belowMinNotional
          ? `Below the ${fmtUsd(minNotional)} minimum.`
          : belowMinQty
            ? `Below the minimum size (${minQuantity} units).`
            : notEnoughUnits
              ? "More than you hold."
              : null;

  const canPlace =
    auth.ready && !busy && !err && order.usd > 0 && !notEnoughUsdc && !notEnoughUnits;

  const place = async () => {
    if (!canPlace) return;
    setBusy(true);
    setResult(null);
    setSettled(false);
    try {
      const r = await placeWealthSpotOrder({
        fund,
        side: tab,
        funds: tab === "buy" ? order.funds : undefined,
        quantity: tab === "sell" ? order.quantity : undefined,
      });
      setResult(r);
      if (r.kind === "ok" || r.kind === "unconfirmed") {
        setAmount("");
        // Gateway settles async — re-read holdings + balance, then mark the
        // order settled so the toast stops showing "updating…".
        window.setTimeout(() => {
          Promise.allSettled([
            refreshBalance(),
            Promise.resolve(onFilled?.()),
          ]).finally(() => setSettled(true));
        }, 1200);
        // A second quiet refresh catches late gateway settlement.
        window.setTimeout(() => {
          void refreshBalance();
          void onFilled?.();
        }, 4000);
      }
    } catch (e) {
      setResult({ kind: "rejected", reason: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!auth.ready) {
    return (
      <div className="rounded-lg border border-line bg-surface p-4">
        <div className="text-[10px] uppercase tracking-wider text-fg-dim">Invest</div>
        <p className="mt-2 text-[12px] text-fg-muted">
          Connect and finish SoDEX setup to buy and sell {fund.displayName} in Helix.
        </p>
        <button
          onClick={() => auth.openSetup()}
          className={buttonClass("primary", "mt-3 w-full py-2 text-[12px]")}
        >
          {auth.step === "wallet" ? "Connect" : "Finish setup"}
        </button>
      </div>
    );
  }

  const takerPct = fee ? (fee.takerFeeRate * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : null;

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      {/* Buy / Sell */}
      <div className="mb-3 grid grid-cols-2 gap-1 rounded-md bg-surface-2/60 p-0.5">
        {(["buy", "sell"] as const).map((t) => (
          <button
            key={t}
            onClick={() => onTab(t)}
            className={cn(
              "rounded py-1.5 text-[12px] font-semibold capitalize transition-colors",
              tab === t
                ? t === "buy"
                  ? "bg-positive/20 text-positive"
                  : "bg-negative/20 text-negative"
                : "text-fg-dim hover:text-fg-muted",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Amount */}
      <div className="rounded-md border border-line bg-surface-2/40 px-3 py-2">
        <div className="flex items-center justify-between text-[10px] text-fg-dim">
          <span>Amount</span>
          <div className="flex items-center gap-1">
            {(["usdc", "units"] as const).map((u) => (
              <button
                key={u}
                onClick={() => setUnit(u)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[9.5px] uppercase",
                  unit === u ? "bg-surface-2 text-fg" : "text-fg-dim hover:text-fg-muted",
                )}
              >
                {u === "usdc" ? "USDC" : fund.symbol}
              </button>
            ))}
          </div>
        </div>
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="0.00"
          className="mt-1 w-full bg-transparent font-[var(--font-jetbrains-mono)] text-[18px] text-fg outline-none placeholder:text-fg-dim"
        />
        <div className="mt-0.5 text-[10.5px] text-fg-dim">
          ≈ {unit === "usdc" ? `${fmtDec(order.units, 6)} ${fund.symbol}` : fmtUsd(order.usd)}
          {price != null ? ` · @ ${fmtUsd(price)}` : ""}
        </div>
      </div>

      {/* Balance / holdings */}
      <div className="mt-2 flex items-center justify-between text-[11px] text-fg-dim">
        {tab === "buy" ? (
          <>
            <span>Spot USDC</span>
            <button
              onClick={() => balance != null && (setUnit("usdc"), setAmount(String(Math.floor(balance * 100) / 100)))}
              className="font-[var(--font-jetbrains-mono)] text-fg-muted hover:text-fg"
            >
              {balance == null ? "…" : fmtUsd(balance)}
            </button>
          </>
        ) : (
          <>
            <span>You hold</span>
            <button
              onClick={() => (setUnit("units"), setAmount(fmtDec(unitsHeld, 8)))}
              className="font-[var(--font-jetbrains-mono)] text-fg-muted hover:text-fg"
            >
              {fmtDec(unitsHeld, 6)} {fund.symbol}
            </button>
          </>
        )}
      </div>

      {/* Fees */}
      <div className="mt-2 flex flex-col gap-0.5 border-t border-line pt-2 text-[10.5px] text-fg-dim">
        <div className="flex justify-between">
          <span>Exchange fee (taker)</span>
          <span>{takerPct != null ? `${takerPct}%` : "SoDEX taker fee"}</span>
        </div>
        <div className="flex justify-between">
          <span>Builder fee</span>
          <span>
            {tab === "buy"
              ? "0% on buys"
              : `${((getBuilderCode("mainnet")?.fee ?? 0) / 1000).toFixed(2)}% on sells`}
          </span>
        </div>
      </div>

      {notEnoughUsdc && (
        <a
          href={SODEX_TRANSFER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 block rounded-md border border-[#e0a53f]/40 bg-[#e0a53f]/10 px-2.5 py-1.5 text-center text-[11px] text-[#e0a53f] hover:bg-[#e0a53f]/20"
        >
          Not enough Spot USDC — move USDC from Perps to Spot on SoDEX ↗
        </a>
      )}

      {err && !notEnoughUsdc && <p className="mt-2 text-[11px] text-negative">{err}</p>}

      <button
        onClick={place}
        disabled={!canPlace}
        className={cn(
          "mt-3 w-full rounded-md py-2.5 text-[13px] font-semibold transition-all",
          !canPlace
            ? "cursor-not-allowed bg-surface-2 text-fg-dim"
            : tab === "buy"
              ? "bg-positive text-[#06281c] hover:brightness-110"
              : "bg-negative text-[#2a0a0f] hover:brightness-110",
        )}
      >
        {busy ? "Placing…" : `${tab === "buy" ? "Buy" : "Sell"} ${fund.symbol}`}
      </button>

      {/* Result */}
      {result && (
        <div
          className={cn(
            "mt-2 rounded-md border px-2.5 py-2 text-[11px]",
            result.kind === "ok"
              ? "border-positive/40 bg-positive/10 text-positive"
              : result.kind === "rejected"
                ? "border-negative/40 bg-negative/10 text-negative"
                : result.kind === "dry_run"
                  ? "border-line bg-surface-2/50 text-fg-muted"
                  : "border-[#e0a53f]/40 bg-[#e0a53f]/10 text-[#e0a53f]",
          )}
        >
          {result.kind === "ok" &&
            (settled
              ? `Order filled${result.orderID ? ` · #${result.orderID}` : ""}. Holdings updated.`
              : `Order placed${result.orderID ? ` · #${result.orderID}` : ""}. Updating holdings…`)}
          {result.kind === "rejected" && `Rejected: ${result.reason}`}
          {result.kind === "unconfirmed" && "Submitted — couldn't confirm the fill. Check your holdings below."}
          {result.kind === "dry_run" && (
            <>
              <div className="font-medium text-fg">DRY RUN — payload (not submitted):</div>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-[var(--font-jetbrains-mono)] text-[9.5px] text-fg-dim">
                {JSON.stringify(result.payload, null, 2)}
              </pre>
            </>
          )}
        </div>
      )}

      <p className="mt-2 text-center text-[9px] text-fg-dim">Market order · IOC · Not financial advice</p>
    </div>
  );
}
