"use client";

/**
 * OrderPanel — the single-source perp order ticket (Arcus/TrueNorth parity).
 *
 * Owns side, order type, size, TP/SL and post-only. Market and
 * Limit both submit through placeLiveOrder() (builder code 8409 attached in
 * the signing path). Submit opens an INLINE confirm step in this same panel;
 * Confirm places the order. Fees come from the symbol's maker/taker rate +
 * getBuilderCode(). Leverage + margin mode are READ-ONLY (set on SoDEX, not
 * from here); no liquidation estimate is shown for a new order — the real one
 * comes from SoDEX's `lp` once a position is open. Account rows are read-only
 * from the perps account state; a Connect CTA shows until the browser is live.
 *
 * NEVER auto-submits — a real mainnet order needs the explicit Confirm click.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { useTradeMode } from "@/lib/sodex-onchain/useTradeMode";
import { useSodexAuth } from "@/components/sodex/auth/SodexAuthProvider";
import { placeLiveOrder } from "@/lib/sodex-onchain/placeLiveOrder";
import { getBuilderCode } from "@/lib/sodex-onchain/chains";
import type { SodexPerpsAccountState } from "@/lib/sodex-onchain/types";
import {
  readLocalKey,
  localKeyExpiry,
  SODEX_MIN_NOTIONAL_USD,
  type KeyExpiry,
} from "@/lib/sodex-onchain/local-keys";
import { useAccount } from "wagmi";

const LONG = "#0ecb81";
const SHORT = "#f6465d";
const NETWORK = "mainnet" as const;

export interface SymbolRules {
  /** Numeric SoDEX symbolID (used for cancels). */
  id: number;
  makerFee: number;
  takerFee: number;
  maxLeverage: number | null;
  initLeverage: number | null;
  fundingInterval: number;
  marginTiers:
    | {
        maxNotionalValue: number;
        maintenanceMarginRate: number;
        maintenanceDeduction: number;
        maxLeverage: number;
      }[]
    | null;
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: number;
  stepSize: number;
  minPrice: number;
  maxPrice: number;
  minQuantity: number;
  maxQuantity: number;
  minNotional: number;
  maxNotional: number;
}

const money = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : `$${v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const pxFmt = (v: number | null | undefined, digits: number) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : v.toLocaleString(undefined, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });

export function OrderPanel({
  symbol,
  sodexSymbol,
  market,
  markPrice,
  lastPrice,
  midPrice,
  rules,
  limitFill,
  account,
  sideFill,
  source,
  onSourceConsumed,
  onPlaced,
}: {
  symbol: string;
  sodexSymbol: string;
  market: "spot" | "perp" | null;
  markPrice: number | null;
  lastPrice?: number | null;
  midPrice?: number | null;
  rules: SymbolRules | null;
  limitFill?: number | null;
  account: SodexPerpsAccountState | null;
  sideFill?: { side: "buy" | "sell"; seq: number } | null;
  /** "event" when deep-linked from the Event Stream — tags only this entry's
   *  clOrdID ("helix-evt-"). Single-use; see onSourceConsumed. */
  source?: "event";
  /** Called once the tag has been used (an order attempt resolved) or a manual
   *  side switch happens, so the parent clears it and later trades aren't
   *  tagged. */
  onSourceConsumed?: () => void;
  /** Fired after any order attempt resolves so the parent re-syncs positions
   *  and open orders from SoDEX (an unconfirmed/partial fill must show truth,
   *  not wait for the 5s poll). */
  onPlaced?: () => void;
}) {
  const tm = useTradeMode(NETWORK);
  const auth = useSodexAuth();
  const { address: connectedMaster } = useAccount();
  const isPerp = market === "perp";
  const digits = markPrice != null && markPrice < 10 ? 4 : 2;

  // ── Form state ──
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<"market" | "limit">("market");
  const [sizeInput, setSizeInput] = useState("");
  const [sizeUnit, setSizeUnit] = useState<"usd" | "base">("usd");
  const [limitPxInput, setLimitPxInput] = useState("");
  const [postOnly, setPostOnly] = useState(false);
  const [tpsl, setTpsl] = useState(false);
  const [stopInput, setStopInput] = useState("");
  const [targetInput, setTargetInput] = useState("");

  // ── Confirm / submit state ──
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Book click → switch to Limit + prefill that price.
  useEffect(() => {
    if (limitFill != null && limitFill > 0) {
      setType("limit");
      setLimitPxInput(String(limitFill));
    }
  }, [limitFill]);

  // Mobile Buy/Sell bar → set the side (seq makes repeated taps re-fire).
  useEffect(() => {
    if (sideFill) setSide(sideFill.side);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideFill?.seq]);

  // Available + current position, derived from the account state (fetched
  // once in the terminal and shared with the bottom tabs).
  const acct = useMemo(() => {
    if (!account) return null;
    const base = (s: string) => (s.split("-")[0] || s).toUpperCase();
    const want = sodexSymbol.toUpperCase();
    // Match the selected market's open position — exact symbol first, then base
    // symbol — so the ticket reads the leverage SoDEX actually applies (the
    // position's `l` from /state) even when the symbol suffix differs.
    const pos =
      account.P?.find((p) => (p.s ?? "").toUpperCase() === want) ??
      account.P?.find((p) => base(p.s ?? "") === base(sodexSymbol));
    return {
      availableUsd: Number(account.am) || 0,
      positionSz: pos ? Number(pos.sz) || 0 : 0,
      positionEntry: pos ? Number(pos.ep) || null : null,
      // Actual leverage + margin mode for this symbol (from /state), if open.
      leverage: pos?.l ?? null,
      marginMode: pos?.m ?? null,
    };
  }, [account, sodexSymbol]);

  // Leverage is READ-ONLY: the ticket does NOT send leverage or margin mode to
  // SoDEX (there is no updateLeverage/setMargin call), so the order inherits the
  // account's current settings. We display the account's actual leverage for
  // this symbol when a position exists, else the contract default. Used only to
  // size the slider's buying power.
  const displayLeverage = acct?.leverage ?? rules?.initLeverage ?? 10;
  const marginModeLabel = acct?.marginMode
    ? acct.marginMode.charAt(0) + acct.marginMode.slice(1).toLowerCase()
    : null;

  // Key expiry → re-authorize gate (mirrors ExecuteLiveButton; S3).
  const [keyExpiry, setKeyExpiry] = useState<KeyExpiry | null>(null);
  useEffect(() => {
    const k = readLocalKey(NETWORK);
    setKeyExpiry(k ? localKeyExpiry(k) : null);
  }, [tm.ready, tm.keyName]);

  // ── Derived pricing ──
  const isLong = side === "buy";
  const parsedLimit = Number(limitPxInput);
  const hasLimit =
    type === "limit" && Number.isFinite(parsedLimit) && parsedLimit > 0;
  const entryPrice =
    type === "market" ? markPrice : hasLimit ? parsedLimit : markPrice;

  const rawSize = Number(sizeInput) || 0;
  const sizeUsd =
    sizeUnit === "usd" ? rawSize : entryPrice ? rawSize * entryPrice : 0;
  const qty = entryPrice && entryPrice > 0 ? sizeUsd / entryPrice : 0;

  // Buying power → slider ceiling. Falls back to a nominal $1000 pre-connect.
  const buyingPower =
    acct?.availableUsd != null ? acct.availableUsd * displayLeverage : null;
  const sliderMax = buyingPower && buyingPower > 0 ? buyingPower : 1000;
  const pct = Math.max(0, Math.min(100, Math.round((sizeUsd / sliderMax) * 100)));

  const setFromPct = (p: number) => {
    // 0% clears the field (shows the placeholder) rather than writing a 0 value.
    if (p <= 0) {
      setSizeInput("");
      return;
    }
    const targetUsd = (p / 100) * sliderMax;
    setSizeInput(
      sizeUnit === "usd"
        ? String(Math.round(targetUsd))
        : entryPrice && entryPrice > 0
          ? (targetUsd / entryPrice).toFixed(rules?.quantityPrecision ?? 4)
          : "",
    );
  };

  // ── Fees: exchange (maker/taker) + builder ──
  const builder = getBuilderCode(NETWORK);
  const builderRate = builder ? builder.fee / 100_000 : 0; // tenths-bp → fraction
  const isMarketableLimit =
    hasLimit &&
    markPrice != null &&
    (isLong ? parsedLimit >= markPrice : parsedLimit <= markPrice);
  const feeKind: "maker" | "taker" =
    type === "market"
      ? "taker"
      : postOnly
        ? "maker"
        : isMarketableLimit
          ? "taker"
          : "maker";
  const exchangeRate =
    feeKind === "taker" ? (rules?.takerFee ?? 0) : (rules?.makerFee ?? 0);
  const exchangeFeeUsd = sizeUsd * exchangeRate;
  const builderFeeUsd = sizeUsd * builderRate;
  const totalFeeUsd = exchangeFeeUsd + builderFeeUsd;
  const totalRate = exchangeRate + builderRate;

  // TP/SL resulting prices (market only this build).
  const stopPct = Number(stopInput);
  const targetPct = Number(targetInput);
  const stopPrice =
    tpsl && entryPrice && stopPct > 0
      ? isLong
        ? entryPrice * (1 - stopPct / 100)
        : entryPrice * (1 + stopPct / 100)
      : null;
  const targetPrice =
    tpsl && entryPrice && targetPct > 0
      ? isLong
        ? entryPrice * (1 + targetPct / 100)
        : entryPrice * (1 - targetPct / 100)
      : null;

  const roundedLimit =
    rules && rules.tickSize > 0
      ? Math.round(parsedLimit / rules.tickSize) * rules.tickSize
      : parsedLimit;

  // ── Validation (client-side; never let the gateway bounce it) ──
  const validate = (): string | null => {
    if (!entryPrice || entryPrice <= 0) return "No live price yet — try again.";
    const minNote = Math.max(SODEX_MIN_NOTIONAL_USD, rules?.minNotional ?? 0);
    if (sizeUsd < minNote) return `Minimum order is ${money(minNote)}.`;
    if (rules?.maxNotional && rules.maxNotional > 0 && sizeUsd > rules.maxNotional)
      return `Maximum order is ${money(rules.maxNotional)}.`;
    if (type === "limit") {
      if (!hasLimit) return "Enter a limit price.";
      if (rules?.minPrice && roundedLimit < rules.minPrice)
        return "Limit price is below the market minimum.";
      if (rules?.maxPrice && rules.maxPrice > 0 && roundedLimit > rules.maxPrice)
        return "Limit price is above the market maximum.";
      if (postOnly && isMarketableLimit)
        return "Post-only would cross the book — lower (buy) / raise (sell) the price to rest.";
    }
    return null;
  };

  const requestConfirm = () => {
    if (sizeUsd <= 0) {
      setMsg("✗ Enter a size.");
      return;
    }
    const err = validate();
    if (err) {
      setMsg(`✗ ${err}`);
      return;
    }
    setMsg(null);
    setConfirming(true);
  };

  const execute = useCallback(async () => {
    try {
      await placeLiveOrder({
        network: NETWORK,
        signal: {
          signal_id: `terminal-${sodexSymbol}-${Date.now().toString(36)}`,
          symbol: sodexSymbol,
          side,
          price_usd: (type === "limit" ? roundedLimit : markPrice) ?? 0,
        },
        identityAddress: readLocalKey(NETWORK)?.address ?? null,
        connectedMaster,
        sizeInput: String(sizeUsd),
        stopInput: type === "market" && tpsl ? stopInput : "",
        targetInput: type === "market" && tpsl ? targetInput : "",
        orderType: type === "limit" ? "LIMIT" : "MARKET",
        limitPrice: type === "limit" ? roundedLimit : undefined,
        timeInForce:
          type === "limit" ? (postOnly ? "POST_ONLY" : "GTC") : undefined,
        source,
        setMsg,
        setBusy,
        setConfirming,
      });
    } finally {
      // Always re-sync from SoDEX after an attempt — success, partial, rejected
      // or unconfirmed — so positions and open orders reflect the exchange.
      onPlaced?.();
      // The Event Stream tag is single-use: consume it after this attempt so a
      // later, unrelated order on this ticket is never tagged "helix-evt-".
      onSourceConsumed?.();
    }
  }, [
    sodexSymbol,
    side,
    type,
    roundedLimit,
    markPrice,
    connectedMaster,
    sizeUsd,
    tpsl,
    stopInput,
    targetInput,
    postOnly,
    source,
    onSourceConsumed,
    onPlaced,
  ]);

  const sideColor = isLong ? LONG : SHORT;
  const sideWord = isPerp ? (isLong ? "Long" : "Short") : isLong ? "Buy" : "Sell";
  const submitLabel = `${isLong ? "Buy" : "Sell"} / ${sideWord} ${symbol}`;
  const pickSide = (s: "buy" | "sell") => {
    // A real side switch is a manual change → drop the Event Stream tag.
    if (s !== side) onSourceConsumed?.();
    setSide(s);
  };

  // ── Sub-renderers ──
  const connectCta = (
    <button
      onClick={() => auth.openSetup()}
      className="flex w-full items-center justify-center rounded-md border border-[color:var(--accent-trade)]/50 bg-[color:var(--accent-trade)]/20 py-3 text-[14px] font-semibold text-[color:var(--accent-trade)] transition-colors hover:bg-[color:var(--accent-trade)]/30"
    >
      {auth.step === "wallet" ? "Connect to trade" : "Finish setup"}
    </button>
  );

  return (
    <div className="flex shrink-0 flex-col gap-2 p-3">
      {/* Leverage + margin mode — READ-ONLY. The ticket does not set these on
          SoDEX, so the order inherits the account's current settings. */}
      {isPerp ? (
        <div
          className="flex items-center justify-between rounded-md border border-line px-3 py-1.5 text-[12px]"
          title="Leverage and margin mode are set on SoDEX — the order inherits your account's current settings for this market."
        >
          <span className="text-fg-dim">{marginModeLabel ?? "Leverage"}</span>
          <span className="font-medium text-fg tabular-nums">
            {displayLeverage}×
            {acct?.leverage == null ? (
              <span className="ml-1 text-[10px] text-fg-dim">default</span>
            ) : null}
          </span>
        </div>
      ) : null}

      {/* Side toggle — segmented control with a sliding active pill. */}
      <div className="relative grid grid-cols-2 rounded-lg bg-surface-2 p-1">
        <span
          aria-hidden
          className="pointer-events-none absolute top-1 bottom-1 rounded-md transition-all duration-150 ease-out"
          style={{
            left: isLong ? "4px" : "50%",
            right: isLong ? "50%" : "4px",
            backgroundColor: isLong ? LONG : SHORT,
          }}
        />
        <button
          onClick={() => pickSide("buy")}
          className={cn(
            "relative z-10 rounded-md py-2 text-[13px] font-semibold transition-colors",
            isLong ? "text-[#0b0e11]" : "text-fg-muted hover:text-fg",
          )}
        >
          {isPerp ? "Buy / Long" : "Buy"}
        </button>
        <button
          onClick={() => pickSide("sell")}
          className={cn(
            "relative z-10 rounded-md py-2 text-[13px] font-semibold transition-colors",
            !isLong ? "text-[#0b0e11]" : "text-fg-muted hover:text-fg",
          )}
        >
          {isPerp ? "Sell / Short" : "Sell"}
        </button>
      </div>

      {/* Market / Limit — underline tabs with an orange (accent) indicator. */}
      <div className="flex items-center gap-5 border-b border-line text-[12px]">
        {(["market", "limit"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={cn(
              "relative pb-2 capitalize transition-colors",
              type === t ? "font-medium text-fg" : "text-fg-dim hover:text-fg-muted",
            )}
          >
            {t}
            <span
              aria-hidden
              className="absolute inset-x-0 -bottom-px h-[2px] rounded-full transition-opacity duration-150"
              style={{
                backgroundColor: "var(--accent-trade)",
                opacity: type === t ? 1 : 0,
              }}
            />
          </button>
        ))}
      </div>

      {/* Limit price + Mid/Last */}
      {type === "limit" ? (
        <label className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-fg-dim">
              Limit price
            </span>
            <div className="flex gap-1">
              {midPrice != null ? (
                <button
                  onClick={() => setLimitPxInput(String(midPrice))}
                  className="rounded border border-line px-1.5 py-0.5 text-[9px] text-fg-dim hover:text-fg"
                >
                  Mid
                </button>
              ) : null}
              {lastPrice != null ? (
                <button
                  onClick={() => setLimitPxInput(String(lastPrice))}
                  className="rounded border border-line px-1.5 py-0.5 text-[9px] text-fg-dim hover:text-fg"
                >
                  Last
                </button>
              ) : null}
            </div>
          </div>
          <div className="flex items-center rounded-md border border-line bg-surface-2 px-3 focus-within:border-[#3a4452]">
            <input
              inputMode="decimal"
              value={limitPxInput}
              onChange={(e) =>
                setLimitPxInput(e.target.value.replace(/[^0-9.]/g, ""))
              }
              className="w-full bg-transparent py-2 text-sm text-fg outline-none focus-visible:[outline:none] tabular-nums"
              placeholder={markPrice != null ? pxFmt(markPrice, digits) : "0"}
            />
            <span className="text-[11px] text-fg-dim">USDC</span>
          </div>
        </label>
      ) : null}

      {/* Account rows */}
      <div className="flex flex-col gap-1 text-[11.5px]">
        <Row
          label="Available to Trade"
          value={acct ? money(acct.availableUsd) : tm.ready ? "—" : "$0.00"}
        />
        <Row
          label="Current Position"
          value={
            acct && acct.positionSz !== 0
              ? `${acct.positionSz > 0 ? "+" : ""}${acct.positionSz.toLocaleString(undefined, { maximumFractionDigits: rules?.quantityPrecision ?? 6 })} ${symbol}`
              : "None"
          }
          tone={
            acct && acct.positionSz > 0
              ? "positive"
              : acct && acct.positionSz < 0
                ? "negative"
                : "muted"
          }
        />
      </div>

      {/* Size */}
      <label className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-fg-dim">
            Size
          </span>
          {rawSize > 0 && qty > 0 ? (
            <span className="text-[10px] text-fg-dim tabular-nums">
              ≈ {qty.toLocaleString(undefined, { maximumFractionDigits: 6 })}{" "}
              {symbol}
            </span>
          ) : null}
        </div>
        {/* Input + unit toggle are ONE control. On focus, only the wrapper's
            1px border lightens to a neutral — no ring, no box-shadow, and the
            input itself has no outline, so the typed number never shifts. */}
        <div className="flex items-center rounded-md border border-line bg-surface-2 px-3 focus-within:border-[#3a4452]">
          <input
            inputMode="decimal"
            value={sizeInput}
            onChange={(e) => setSizeInput(e.target.value.replace(/[^0-9.]/g, ""))}
            className="w-full bg-transparent py-2 text-sm text-fg outline-none placeholder:text-fg-dim focus-visible:[outline:none] tabular-nums"
            placeholder="0.00"
          />
          <button
            onClick={() => setSizeUnit((u) => (u === "usd" ? "base" : "usd"))}
            className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-muted hover:text-fg"
            title="Toggle size unit"
          >
            {sizeUnit === "usd" ? "USDC" : symbol}
          </button>
        </div>
      </label>

      {/* Slider + % chips */}
      <input
        type="range"
        min={0}
        max={100}
        value={pct}
        onChange={(e) => setFromPct(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-surface-2"
        style={{ accentColor: sideColor }}
        aria-label="Size percent of buying power"
      />
      <div className="grid grid-cols-4 gap-1">
        {[25, 50, 75, 100].map((p) => (
          <button
            key={p}
            onClick={() => setFromPct(p)}
            className="rounded border border-line py-0.5 text-[10px] tabular-nums text-fg-dim hover:border-line-2 hover:text-fg"
          >
            {p}%
          </button>
        ))}
      </div>

      {/* TP / SL — market only this build */}
      {type === "market" ? (
        <div className="flex flex-col gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 text-[11.5px] text-fg-muted">
            <input
              type="checkbox"
              checked={tpsl}
              onChange={(e) => setTpsl(e.target.checked)}
              className="h-3 w-3 accent-accent"
            />
            Take Profit / Stop Loss
          </label>
          {tpsl ? (
            <div className="grid grid-cols-2 gap-2">
              <BracketInput
                label="Stop %"
                value={stopInput}
                onChange={setStopInput}
                price={stopPrice}
                digits={digits}
                color={SHORT}
              />
              <BracketInput
                label="Target %"
                value={targetInput}
                onChange={setTargetInput}
                price={targetPrice}
                digits={digits}
                color={LONG}
              />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 text-[11.5px] text-fg-muted">
            <input
              type="checkbox"
              checked={postOnly}
              onChange={(e) => setPostOnly(e.target.checked)}
              className="h-3 w-3 accent-accent"
            />
            Post only{" "}
            <span className="text-[10px] text-fg-dim">(maker fee)</span>
          </label>
          <span className="text-[10px] text-fg-dim">
            TP/SL on limit orders coming soon.
          </span>
        </div>
      )}

      {/* Submit / confirm */}
      <div>
        {auth.loading ? (
          <div className="h-[42px] animate-pulse rounded-md bg-surface-2" />
        ) : !auth.ready ? (
          connectCta
        ) : confirming && sizeUsd > 0 ? (
          <ConfirmStep
            side={side}
            isPerp={isPerp}
            symbol={symbol}
            sizeUsd={sizeUsd}
            qty={qty}
            entry={entryPrice}
            type={type}
            postOnly={postOnly}
            stop={stopPrice}
            target={targetPrice}
            exchangeFeeUsd={exchangeFeeUsd}
            exchangeRate={exchangeRate}
            builderFeeUsd={builderFeeUsd}
            builderRate={builderRate}
            totalFeeUsd={totalFeeUsd}
            totalRate={totalRate}
            feeKind={feeKind}
            digits={digits}
            busy={busy}
            onConfirm={execute}
            onCancel={() => setConfirming(false)}
          />
        ) : (
          <button
            onClick={requestConfirm}
            disabled={busy || sizeUsd <= 0}
            className={cn(
              "w-full rounded-md py-3 text-[14px] font-semibold transition-all duration-150",
              sizeUsd <= 0
                ? "cursor-not-allowed opacity-50"
                : "hover:-translate-y-px hover:shadow-lg hover:brightness-[1.06]",
            )}
            style={{ backgroundColor: sideColor, color: "#0b0e11" }}
          >
            {submitLabel}
          </button>
        )}
        {/* Quiet real-funds reminder — orders on this ticket execute on SoDEX
            mainnet with real capital (the Confirm step is still required). */}
        <div className="mt-2 flex items-center justify-center gap-1.5 text-[10px] text-fg-dim">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: "var(--accent-trade)" }}
          />
          SoDEX mainnet · real funds
        </div>
        {keyExpiry?.state === "expiring" && auth.ready ? (
          <button
            onClick={() => auth.generateKey()}
            className="mt-1.5 block w-full text-center text-[10px] hover:underline"
            style={{ color: "#e0a53f" }}
          >
            ⚠ Trading key expiring — renew
          </button>
        ) : null}
        {msg ? (
          <p
            className="mt-1.5 text-center text-[11px]"
            style={{ color: msg.startsWith("✗") ? SHORT : LONG }}
          >
            {msg}
          </p>
        ) : null}
      </div>

      {/* Order details */}
      <div className="flex flex-col gap-1.5 border-t border-line pt-3 text-[11.5px]">
        <Row label="Order Value" value={money(sizeUsd > 0 ? sizeUsd : null)} />
        <Row
          label={type === "market" ? "Expected Price" : "Limit Price"}
          value={pxFmt(entryPrice, digits)}
        />
      </div>

      {/* Fee breakdown — exchange (maker/taker) + builder, kept separate */}
      <div className="flex flex-col gap-1 border-t border-line pt-3">
        <FeeRow
          label={`Exchange fee (${feeKind})`}
          rate={exchangeRate}
          usd={sizeUsd > 0 ? exchangeFeeUsd : null}
        />
        <FeeRow
          label="Builder fee"
          rate={builderRate}
          usd={sizeUsd > 0 ? builderFeeUsd : null}
        />
        <FeeRow
          label="Total"
          rate={totalRate}
          usd={sizeUsd > 0 ? totalFeeUsd : null}
          strong
        />
      </div>

    </div>
  );
}

function BracketInput({
  label,
  value,
  onChange,
  price,
  digits,
  color,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  price: number | null;
  digits: number;
  color: string;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-wider text-fg-dim">
        {label}
      </span>
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
        placeholder="0"
        className="rounded border border-line bg-surface-2 px-2 py-1 text-xs tabular-nums outline-none focus:border-[#3a4452] focus-visible:[outline:none]"
      />
      <span className="text-[9px] tabular-nums" style={{ color }}>
        {price != null ? pxFmt(price, digits) : "—"}
      </span>
    </label>
  );
}

function ConfirmStep(p: {
  side: "buy" | "sell";
  isPerp: boolean;
  symbol: string;
  sizeUsd: number;
  qty: number;
  entry: number | null;
  type: "market" | "limit";
  postOnly: boolean;
  stop: number | null;
  target: number | null;
  exchangeFeeUsd: number;
  exchangeRate: number;
  builderFeeUsd: number;
  builderRate: number;
  totalFeeUsd: number;
  totalRate: number;
  feeKind: "maker" | "taker";
  digits: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isLong = p.side === "buy";
  const color = isLong ? LONG : SHORT;
  const word = p.isPerp ? (isLong ? "Long" : "Short") : isLong ? "Buy" : "Sell";
  return (
    <div className="rounded-md border p-3" style={{ borderColor: color }}>
      <div className="mb-2 text-[12px]">
        <span className="font-semibold" style={{ color }}>
          {word}
        </span>{" "}
        <span className="text-fg">{p.symbol}</span>{" "}
        <span className="text-fg-dim">
          · {p.type === "limit" ? (p.postOnly ? "Limit · post-only" : "Limit") : "Market"}
        </span>
      </div>
      <div className="flex flex-col gap-1 text-[11px]">
        <CRow label="Size" value={money(p.sizeUsd)} />
        <CRow
          label="Est. Quantity"
          value={`${p.qty.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${p.symbol}`}
        />
        <CRow
          label={p.type === "limit" ? "Limit Price" : "Est. Entry"}
          value={pxFmt(p.entry, p.digits)}
        />
        {p.stop != null ? (
          <CRow label="Stop Price" value={pxFmt(p.stop, p.digits)} tone={SHORT} />
        ) : null}
        {p.target != null ? (
          <CRow
            label="Target Price"
            value={pxFmt(p.target, p.digits)}
            tone={LONG}
          />
        ) : null}
        <div className="my-1 border-t border-line" />
        <FeeRow
          label={`Exchange fee (${p.feeKind})`}
          rate={p.exchangeRate}
          usd={p.exchangeFeeUsd}
        />
        <FeeRow label="Builder fee" rate={p.builderRate} usd={p.builderFeeUsd} />
        <FeeRow label="Total" rate={p.totalRate} usd={p.totalFeeUsd} strong />
      </div>
      <div className="mt-2 flex gap-2">
        <button
          onClick={p.onConfirm}
          disabled={p.busy}
          className={cn(
            "flex-1 rounded py-2 text-[13px] font-semibold",
            p.busy ? "cursor-wait opacity-70" : "",
          )}
          style={{ backgroundColor: color, color: "#0b0e11" }}
        >
          {p.busy ? "Signing…" : "Confirm"}
        </button>
        <button
          onClick={p.onCancel}
          disabled={p.busy}
          className="flex-1 rounded border border-line py-2 text-[13px] text-fg-muted hover:text-fg"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function FeeRow({
  label,
  rate,
  usd,
  strong,
}: {
  label: string;
  rate: number;
  usd: number | null;
  strong?: boolean;
}) {
  const numCls = cn(
    "text-right font-[var(--font-jetbrains-mono)] tabular-nums",
    strong ? "text-fg" : "text-fg-muted",
  );
  return (
    <div className="grid grid-cols-[1fr_52px_72px] items-center gap-2 text-[11.5px]">
      <span className={strong ? "text-fg-muted" : "text-fg-dim"}>{label}</span>
      <span className={numCls}>{(rate * 100).toFixed(3)}%</span>
      <span className={numCls}>{usd != null ? money(usd, 4) : "—"}</span>
    </div>
  );
}

function CRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "muted" | string;
}) {
  const color =
    tone && tone !== "muted" ? tone : undefined;
  return (
    <div className="flex items-center justify-between">
      <span className="text-fg-dim">{label}</span>
      <span
        className={cn(
          "font-[var(--font-jetbrains-mono)] tabular-nums",
          tone === "muted" ? "text-fg-muted" : !color && "text-fg",
        )}
        style={color ? { color } : undefined}
      >
        {value}
      </span>
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
          "font-[var(--font-jetbrains-mono)] tabular-nums",
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
