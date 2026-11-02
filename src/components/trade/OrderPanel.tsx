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
import { placeLiveOrder } from "@/lib/sodex-onchain/placeLiveOrder";
import { getBuilderCode } from "@/lib/sodex-onchain/chains";
import type { SodexPerpsAccountState } from "@/lib/sodex-onchain/types";
import {
  readLocalKey,
  readTradesToday,
  localKeyExpiry,
  SODEX_MIN_NOTIONAL_USD,
  type KeyExpiry,
} from "@/lib/sodex-onchain/local-keys";
import { useAccount } from "wagmi";

const LONG = "#0ecb81";
const SHORT = "#f6465d";
const NETWORK = "mainnet" as const;

export interface SymbolRules {
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
}) {
  const tm = useTradeMode(NETWORK);
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
  const [, setTradesToday] = useState(() => readTradesToday(NETWORK));

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
    const pos = account.P?.find(
      (p) => (p.s ?? "").toUpperCase() === sodexSymbol.toUpperCase(),
    );
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
    const targetUsd = (p / 100) * sliderMax;
    setSizeInput(
      sizeUnit === "usd"
        ? String(Math.round(targetUsd))
        : entryPrice && entryPrice > 0
          ? (targetUsd / entryPrice).toFixed(rules?.quantityPrecision ?? 4)
          : "0",
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
    const err = validate();
    if (err) {
      setMsg(`✗ ${err}`);
      return;
    }
    setMsg(null);
    setConfirming(true);
  };

  const execute = useCallback(async () => {
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
      setMsg,
      setBusy,
      setConfirming,
      setTradesToday,
    });
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
  ]);

  const sideColor = isLong ? LONG : SHORT;
  const sideWord = isPerp ? (isLong ? "Long" : "Short") : isLong ? "Buy" : "Sell";
  const submitLabel = `${isLong ? "Buy" : "Sell"} / ${sideWord} ${symbol}`;

  // ── Sub-renderers ──
  const connectCta = (
    <Link
      href="/settings/connect-sodex"
      className="flex items-center justify-center rounded-md border border-accent/50 bg-accent/15 py-2.5 text-[13px] font-semibold text-accent-2 transition-colors hover:bg-accent/25"
    >
      Connect SoDEX
    </Link>
  );

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
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

      {/* Side toggle */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => setSide("buy")}
          className="rounded-md py-2 text-[13px] font-semibold transition-colors"
          style={
            isLong
              ? { backgroundColor: LONG, color: "#0b0e11" }
              : { backgroundColor: "var(--surface-2,#1a1f27)", color: "#848e9c" }
          }
        >
          {isPerp ? "Buy / Long" : "Buy"}
        </button>
        <button
          onClick={() => setSide("sell")}
          className="rounded-md py-2 text-[13px] font-semibold transition-colors"
          style={
            !isLong
              ? { backgroundColor: SHORT, color: "#0b0e11" }
              : { backgroundColor: "var(--surface-2,#1a1f27)", color: "#848e9c" }
          }
        >
          {isPerp ? "Sell / Short" : "Sell"}
        </button>
      </div>

      {/* Market / Limit */}
      <div className="flex items-center gap-4 text-[12px]">
        {(["market", "limit"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={cn(
              "capitalize transition-colors",
              type === t
                ? "border-b-2 border-accent pb-0.5 font-medium text-fg"
                : "text-fg-dim hover:text-fg",
            )}
          >
            {t}
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
          <div className="flex items-center rounded-md border border-line bg-surface-2 px-3">
            <input
              inputMode="decimal"
              value={limitPxInput}
              onChange={(e) =>
                setLimitPxInput(e.target.value.replace(/[^0-9.]/g, ""))
              }
              className="w-full bg-transparent py-2 text-sm text-fg outline-none tabular-nums"
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
              ? `${acct.positionSz > 0 ? "+" : ""}${acct.positionSz.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${symbol}`
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
          <span className="text-[10px] text-fg-dim">
            ≈{" "}
            {qty > 0
              ? qty.toLocaleString(undefined, { maximumFractionDigits: 4 })
              : "—"}{" "}
            {symbol}
          </span>
        </div>
        <div className="flex items-center rounded-md border border-line bg-surface-2 px-3">
          <input
            inputMode="decimal"
            value={sizeInput}
            onChange={(e) => setSizeInput(e.target.value.replace(/[^0-9.]/g, ""))}
            className="w-full bg-transparent py-2 text-sm text-fg outline-none tabular-nums"
            placeholder="0"
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
        {tm.loading ? (
          <div className="h-[42px] animate-pulse rounded-md bg-surface-2" />
        ) : !tm.ready ? (
          connectCta
        ) : keyExpiry?.state === "expired" ? (
          <Link
            href="/settings/connect-sodex"
            className="flex items-center justify-center rounded-md border border-negative/50 bg-negative/10 py-2.5 text-[13px] font-semibold text-negative hover:bg-negative/20"
          >
            ⚠ Trading key expired — re-authorize
          </Link>
        ) : confirming ? (
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
              "w-full rounded-md py-2.5 text-[14px] font-semibold transition-opacity",
              sizeUsd <= 0 ? "cursor-not-allowed opacity-50" : "hover:opacity-90",
            )}
            style={{ backgroundColor: sideColor, color: "#0b0e11" }}
          >
            {submitLabel}
          </button>
        )}
        {keyExpiry?.state === "expiring" && tm.ready ? (
          <Link
            href="/settings/connect-sodex"
            className="mt-1.5 block text-center text-[10px] hover:underline"
            style={{ color: "#e0a53f" }}
          >
            ⚠ Trading key expiring — re-authorize soon
          </Link>
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
        <Row
          label={`Fee · ${feeKind}`}
          value={
            sizeUsd > 0
              ? `${money(totalFeeUsd, 4)} · ${(totalRate * 100).toFixed(3)}%`
              : `${(totalRate * 100).toFixed(3)}%`
          }
          tone="muted"
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
        className="rounded border border-line bg-surface-2 px-2 py-1 text-xs tabular-nums outline-none focus:border-accent/50"
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
        <CRow
          label={`Exchange fee (${p.feeKind})`}
          value={`${money(p.exchangeFeeUsd, 4)} · ${(p.exchangeRate * 100).toFixed(3)}%`}
          tone="muted"
        />
        <CRow
          label="Builder fee"
          value={`${money(p.builderFeeUsd, 4)} · ${(p.builderRate * 100).toFixed(3)}%`}
          tone="muted"
        />
        <CRow
          label="Total fee"
          value={`${money(p.totalFeeUsd, 4)} · ${(p.totalRate * 100).toFixed(3)}%`}
        />
      </div>
      <p className="mt-2 text-[10px]" style={{ color: SHORT }}>
        ⚠ Real funds on SoDEX Mainnet.
      </p>
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
