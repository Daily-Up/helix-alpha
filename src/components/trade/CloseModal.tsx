"use client";

/**
 * CloseModal — centered close / partial-close editor for an open position, in
 * the same style as TpSlModal. Replaces the old order-ticket takeover: the × on
 * a position row opens this and the ticket is never touched. Size ⇄ USD, the
 * slider and the % box all stay in sync (default = full position). "Limit" ticks
 * a reduce-only limit at a chosen price; otherwise a market reduce-only close.
 * Submits through the existing placeLiveOrder reduce-only path (no signing
 * change); the ✓ Closed / error result is surfaced as a toast by the caller.
 */

import { useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";
import { AssetLogo } from "@/components/ui/AssetLogo";
import type { SodexPerpsAccountState } from "@/lib/sodex-onchain/types";
import type { TpSlMeta } from "./TpSlModal";

type Position = NonNullable<SodexPerpsAccountState["P"]>[number];

const LONG = "#0ecb81";
const SHORT = "#f6465d";
const baseOf = (s: string) => s.split("-")[0] || s;
const signStr = (v: number) => (v < 0 ? "−" : "+");
const money = (v: number) => {
  const a = Math.abs(v);
  if (a > 0 && a < 0.01) return `${signStr(v)}<$0.01`;
  return `${signStr(v)}$${a.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const usd = (v: number) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const decimalsFromTick = (tick?: number) => {
  if (!tick || !Number.isFinite(tick) || tick <= 0) return 2;
  if (tick >= 1) return 0;
  return Math.min(8, Math.ceil(-Math.log10(tick)));
};
const trimZeros = (s: string) =>
  s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
const clean = (v: string) => v.replace(/[^0-9.]/g, "");

export function CloseModal({
  position,
  meta,
  mark,
  mid,
  last,
  builderRate,
  limitDefault,
  onSubmit,
  onClose,
}: {
  position: Position;
  meta: TpSlMeta | null;
  mark: number | null;
  /** Selected-market mid, when this position IS the selected market (else null). */
  mid: number | null;
  /** Selected-market last, when this position IS the selected market (else null). */
  last: number | null;
  builderRate: number;
  /** Open with "Limit" pre-ticked (the ⋯ menu's "Limit close"). */
  limitDefault: boolean;
  onSubmit: (
    pos: Position,
    opts: { sizeBase: number; type: "market" | "limit"; limitPrice?: number },
  ) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}) {
  const entry = Number(position.ep);
  const signed = Number(position.sz);
  const full = Math.abs(signed);
  const isLong = signed >= 0;
  const lev = position.l ?? null;
  const margin = lev && lev > 0 ? (full * entry) / lev : null;
  const upnl = position.ur != null ? Number(position.ur) : null;
  const pxDp = meta ? decimalsFromTick(meta.tickSize) : mark != null && mark < 10 ? 4 : 2;
  const qDp = meta ? meta.quantityPrecision : 4;
  const takerFee = meta ? meta.takerFee : 0.0004;
  const base = baseOf(position.s);
  const fmtPx = (v: number) =>
    trimZeros(v.toLocaleString(undefined, { minimumFractionDigits: pxDp, maximumFractionDigits: pxDp }));
  const fmtQty = (v: number) => trimZeros(v.toFixed(qDp));

  // ── State ──
  const [asLimit, setAsLimit] = useState(limitDefault);
  const [limitStr, setLimitStr] = useState(mark != null ? fmtPx(mark) : "");
  const [unit, setUnit] = useState<"base" | "usd">("base");
  const [sizeStr, setSizeStr] = useState(() => fmtQty(full)); // default = full
  const [pctStr, setPctStr] = useState("100");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Esc closes.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const limitPx = Number(clean(limitStr));
  const limitOk = asLimit && Number.isFinite(limitPx) && limitPx > 0;
  // Reference price for USD ⇄ base and realized PnL: the limit when closing as a
  // limit (and valid), else the mark.
  const refPx = limitOk ? limitPx : mark ?? 0;

  const parsedSize = Number(clean(sizeStr));
  const rawBase =
    unit === "base" ? parsedSize : refPx > 0 ? parsedSize / refPx : 0;
  const closeBase = Math.min(Math.max(Number.isFinite(rawBase) ? rawBase : 0, 0), full);
  const sliderPct = Math.min(100, Math.max(0, Number(clean(pctStr)) || 0));

  // ── Size ⇄ % ⇄ USD sync (price⇄gain style) ──
  const sizeFromBase = (b: number) =>
    unit === "base" ? fmtQty(b) : trimZeros((b * refPx).toFixed(2));
  const onSize = (v: string) => {
    const cv = clean(v);
    setSizeStr(cv);
    const n = Number(cv);
    const b = unit === "base" ? n : refPx > 0 ? n / refPx : 0;
    const p = full > 0 && Number.isFinite(b) ? Math.min(100, (b / full) * 100) : 0;
    setPctStr(cv.trim() ? trimZeros(p.toFixed(2)) : "");
  };
  const onPct = (v: string) => {
    const cv = clean(v);
    setPctStr(cv);
    const p = Math.min(100, Math.max(0, Number(cv) || 0));
    const b = (full * p) / 100;
    setSizeStr(cv.trim() ? sizeFromBase(b) : "");
  };
  const setPct = (p: number) => {
    setPctStr(trimZeros(p.toFixed(2)));
    setSizeStr(sizeFromBase((full * p) / 100));
  };
  const toggleUnit = () => {
    const next = unit === "base" ? "usd" : "base";
    const b = closeBase;
    setUnit(next);
    setSizeStr(
      sizeStr.trim()
        ? next === "base"
          ? fmtQty(b)
          : trimZeros((b * refPx).toFixed(2))
        : "",
    );
  };

  // ── Derived info ──
  const closeUsd = closeBase * refPx;
  const realizedPnl = (refPx - entry) * (isLong ? closeBase : -closeBase);
  const closedMargin = margin != null && full > 0 ? margin * (closeBase / full) : null;
  const roePct = closedMargin && closedMargin > 0 ? (realizedPnl / closedMargin) * 100 : null;
  const feeTotal = closeUsd * (takerFee + builderRate);
  const remaining = full - closeBase;
  const partial = remaining > full * 1e-6 && closeBase > 0;

  const canSubmit = closeBase > 0 && (!asLimit || limitOk) && !submitting;
  // Closing a LONG is a SELL (short-side colour); closing a SHORT is a BUY.
  const actionColor = isLong ? SHORT : LONG;
  const label = `Close ${base} ${isLong ? "Long" : "Short"}`;

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    const res = await onSubmit(position, {
      sizeBase: closeBase,
      type: asLimit ? "limit" : "market",
      limitPrice: asLimit ? limitPx : undefined,
    });
    setSubmitting(false);
    if (res.ok) onClose();
    else setError(res.error ?? "Close failed.");
  };

  const quick: { label: string; v: number }[] = [];
  if (mark != null) quick.push({ label: "Mark", v: mark });
  if (mid != null) quick.push({ label: "Mid", v: mid });
  if (last != null) quick.push({ label: "Last", v: last });

  return (
    <div
      className="trade-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.66)", backdropFilter: "blur(2px)" }}
      onClick={onClose}
    >
      <div
        className="trade-modal-panel flex max-h-[90vh] w-[480px] max-w-full flex-col overflow-hidden rounded-xl border border-line bg-surface-2 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title */}
        <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3">
          <div className="flex items-center gap-2.5">
            <AssetLogo symbol={position.s} size={22} />
            <span className="text-[15px] font-semibold text-fg">
              Close {base} Position
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-[18px] leading-none text-fg-dim hover:text-fg"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* Summary */}
          <div className="mb-4 rounded-lg border border-line bg-surface-2/60 p-3 text-[12px]">
            <Row
              label="Size"
              value={`${isLong ? "+" : "−"}${fmtQty(full)} ${base}`}
              tone={isLong ? "pos" : "neg"}
            />
            <Row label="Mark Price" value={mark != null ? fmtPx(mark) : "—"} />
            <Row label="Avg. Entry Price" value={fmtPx(entry)} />
            <Row
              label="Unrealized PnL"
              value={upnl != null ? money(upnl) : "—"}
              tone={upnl == null ? undefined : upnl >= 0 ? "pos" : "neg"}
            />
          </div>

          {/* Close amount */}
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[12px] font-medium text-fg">Close Amount</span>
            <span className="text-[10px] text-fg-dim">
              {trimZeros(sliderPct.toFixed(1))}% of position
            </span>
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            {/* Size input + unit toggle + ≈$ */}
            <div className="flex items-center rounded-md border border-line bg-surface-2 px-2.5 focus-within:border-[#3a4452]">
              <input
                inputMode="decimal"
                value={sizeStr}
                onChange={(e) => onSize(e.target.value)}
                placeholder="0"
                className="w-full bg-transparent py-2 text-right text-[13px] tabular-nums text-fg outline-none placeholder:text-fg-dim"
              />
              <span className="ml-2 shrink-0 text-[10px] text-fg-dim">
                {unit === "base" ? `≈ ${usd(closeUsd)}` : `≈ ${fmtQty(closeBase)} ${base}`}
              </span>
              <button
                onClick={toggleUnit}
                title="Switch coin / USD"
                className="ml-1 shrink-0 rounded border border-line px-1 text-[10px] text-fg-muted hover:text-fg"
              >
                {unit === "base" ? base : "USD"} ⇄
              </button>
            </div>
            {/* % box */}
            <div className="flex w-20 items-center rounded-md border border-line bg-surface-2 px-2">
              <input
                inputMode="decimal"
                value={pctStr}
                onChange={(e) => onPct(e.target.value)}
                placeholder="0"
                className="w-full bg-transparent py-2 text-right text-[13px] tabular-nums text-fg outline-none placeholder:text-fg-dim"
              />
              <span className="pl-0.5 text-[11px] text-fg-dim">%</span>
            </div>
          </div>
          {/* Slider + presets */}
          <div className="mt-3 flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              value={sliderPct}
              onChange={(e) => setPct(Number(e.target.value))}
              className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-surface-2"
              style={{ accentColor: actionColor }}
            />
          </div>
          <div className="mt-2 grid grid-cols-5 gap-1.5">
            {[0, 25, 50, 75, 100].map((p) => (
              <button
                key={p}
                onClick={() => setPct(p)}
                className={cn(
                  "rounded border py-1 text-[10.5px] tabular-nums transition-colors",
                  Math.round(sliderPct) === p
                    ? "border-line-2 bg-surface-2 text-fg"
                    : "border-line text-fg-muted hover:text-fg",
                )}
              >
                {p === 100 ? "Max" : `${p}%`}
              </button>
            ))}
          </div>

          <div className="my-4 border-t border-line" />

          {/* Limit toggle + price */}
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-fg-muted" title="Close with a reduce-only limit order at the price below instead of at market.">
            <input
              type="checkbox"
              checked={asLimit}
              onChange={(e) => setAsLimit(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            Limit
            <span className="text-[10px] text-fg-dim">reduce-only limit at a set price</span>
          </label>
          {asLimit ? (
            <div className="mt-2 flex items-center gap-2">
              <div className="flex flex-1 items-center rounded-md border border-line bg-surface-2 px-2.5 focus-within:border-[#3a4452]">
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-fg-dim">Price</span>
                <input
                  inputMode="decimal"
                  value={limitStr}
                  onChange={(e) => setLimitStr(clean(e.target.value))}
                  placeholder="0.00"
                  className="w-full bg-transparent py-2 text-right text-[13px] tabular-nums text-fg outline-none placeholder:text-fg-dim"
                />
              </div>
              {quick.map((q) => (
                <button
                  key={q.label}
                  onClick={() => setLimitStr(fmtPx(q.v))}
                  className="shrink-0 rounded border border-line px-2 py-2 text-[10px] text-fg-muted transition-colors hover:text-fg"
                >
                  {q.label}
                </button>
              ))}
            </div>
          ) : null}

          {/* Info rows */}
          <div className="mt-4 flex flex-col gap-1 text-[11px]">
            <InfoRow label="Order Value" value={closeBase > 0 ? usd(closeUsd) : "—"} />
            <InfoRow
              label="Est. realized PnL"
              value={
                closeBase > 0
                  ? `${money(realizedPnl)}${roePct != null ? `  (${roePct >= 0 ? "+" : "−"}${Math.abs(roePct).toFixed(2)}%)` : ""}`
                  : "—"
              }
              tone={closeBase <= 0 ? undefined : realizedPnl >= 0 ? "pos" : "neg"}
            />
            <InfoRow
              label="Est. fee (exchange + builder)"
              value={closeBase > 0 ? `$${feeTotal.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}` : "—"}
            />
            {partial ? (
              <InfoRow label="Remaining after close" value={`${fmtQty(remaining)} ${base}`} />
            ) : null}
          </div>

          {error ? <p className="mt-2 text-[11px] text-negative">{error}</p> : null}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-line px-5 py-3">
          <button
            onClick={submit}
            disabled={!canSubmit}
            className={cn(
              "w-full rounded-lg py-2.5 text-[14px] font-semibold transition-opacity",
              canSubmit ? "hover:opacity-90" : "cursor-not-allowed bg-surface-2 text-fg-dim",
            )}
            style={canSubmit ? { backgroundColor: actionColor, color: "#0b0e11" } : undefined}
          >
            {submitting ? "Closing…" : label}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg";
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-fg-dim">{label}</span>
      <span
        className={cn(
          "font-[var(--font-jetbrains-mono)] tabular-nums",
          tone === "pos" ? "text-positive" : tone === "neg" ? "text-negative" : "text-fg",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function InfoRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg";
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-fg-dim">{label}</span>
      <span
        className={cn(
          "font-[var(--font-jetbrains-mono)] tabular-nums",
          tone === "pos" ? "text-positive" : tone === "neg" ? "text-negative" : "text-fg-muted",
        )}
      >
        {value}
      </span>
    </div>
  );
}
