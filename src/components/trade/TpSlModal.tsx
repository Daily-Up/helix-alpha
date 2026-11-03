"use client";

/**
 * TpSlModal — centered Take-Profit / Stop-Loss editor for an open position,
 * usable for ANY position (symbol metadata is passed in, so no market switch).
 * Price ⇄ Gain/Loss are kept in sync; Gain/Loss toggles between % (price move
 * from entry, not ROE) and $. Supports Limit execution, partial size, and a fee
 * line. A resting leg can be marked "✕ Cancel TP/SL" (greys out, Undo); the
 * cancel runs on Confirm alongside any other change, through the signing path.
 */

import { useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";
import { AssetLogo } from "@/components/ui/AssetLogo";
import type { SodexPerpsAccountState } from "@/lib/sodex-onchain/types";

type Position = NonNullable<SodexPerpsAccountState["P"]>[number];

export type TpSlMeta = {
  symbolID: number;
  tickSize: number;
  stepSize: number;
  pricePrecision: number;
  quantityPrecision: number;
  takerFee: number;
};

const perpName = (s: string) => s.replace(/-USDC?$/i, "-PERP");
const baseOf = (s: string) => s.split("-")[0] || s;
const signStr = (v: number) => (v < 0 ? "−" : "+");
// Signed $, 2 decimals; a non-zero magnitude under a cent collapses to "±<$0.01".
const money = (v: number) => {
  const a = Math.abs(v);
  if (a > 0 && a < 0.01) return `${signStr(v)}<$0.01`;
  return `${signStr(v)}$${a.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const decimalsFromTick = (tick?: number) => {
  if (!tick || !Number.isFinite(tick) || tick <= 0) return 2;
  if (tick >= 1) return 0;
  return Math.min(8, Math.ceil(-Math.log10(tick)));
};
const trimZeros = (s: string) =>
  s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;

export function TpSlModal({
  position,
  meta,
  mark,
  builderRate,
  existing,
  focus,
  placementEnabled,
  busy,
  onSet,
  onClose,
}: {
  position: Position;
  meta: TpSlMeta | null;
  mark: number | null;
  builderRate: number;
  existing: { tp: number | null; sl: number | null; tpOrderId: number | null; slOrderId: number | null };
  focus: "tp" | "sl" | null;
  placementEnabled: boolean;
  busy: boolean;
  onSet: (
    pos: Position,
    next: { tp: number | "cancel" | null; sl: number | "cancel" | null },
    ex: { tpOrderId: number | null; slOrderId: number | null },
  ) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}) {
  const entry = Number(position.ep);
  const signed = Number(position.sz);
  const absSize = Math.abs(signed);
  const isLong = signed >= 0;
  const lev = position.l ?? null;
  const liq = position.lp && Number(position.lp) > 0 ? Number(position.lp) : null;
  const margin = lev && lev > 0 ? (absSize * entry) / lev : null;
  // Price precision from THIS symbol's tick size (not the selected market's).
  const pxDp = meta ? decimalsFromTick(meta.tickSize) : mark != null && mark < 10 ? 4 : 2;
  const qDp = meta ? meta.quantityPrecision : 4;
  const takerFee = meta ? meta.takerFee : 0.0004;
  // Display: tick precision, trailing zeros trimmed (71,000.0000 → 71,000).
  const fmtPx = (v: number) =>
    trimZeros(
      v.toLocaleString(undefined, { minimumFractionDigits: pxDp, maximumFractionDigits: pxDp }),
    );
  // Input value strings carry NO thousands separators, so Number() parses them.
  const fmtIn = (v: number) => trimZeros(v.toFixed(pxDp));
  const num = (s: string) => Number(s.replace(/,/g, ""));

  // Size for PnL/fees — full position unless "Configure size" trims it.
  const [configureSize, setConfigureSize] = useState(false);
  const [sizePct, setSizePct] = useState(100);
  const size = configureSize ? absSize * (sizePct / 100) : absSize;
  const signedSize = isLong ? size : -size;
  const [asLimit, setAsLimit] = useState(false);

  // Price ⇄ Gain/Loss. The directional move is +gain for a TP, −loss for a SL.
  const gainFromPrice = (price: number, unit: "pct" | "usd") =>
    unit === "pct"
      ? ((price - entry) / entry) * 100 * (isLong ? 1 : -1)
      : (price - entry) * signedSize;
  const priceFromGain = (gain: number, unit: "pct" | "usd") =>
    unit === "pct"
      ? entry * (1 + (gain / 100) * (isLong ? 1 : -1))
      : entry + gain / (signedSize || 1);
  const fmtGain = (g: number, unit: "pct" | "usd") =>
    unit === "pct" ? g.toFixed(2) : g.toFixed(2);

  const [tp, setTp] = useState({
    price: existing.tp != null ? fmtIn(existing.tp) : "",
    gain:
      existing.tp != null ? fmtGain(gainFromPrice(existing.tp, "pct"), "pct") : "",
    unit: "pct" as "pct" | "usd",
  });
  const [sl, setSl] = useState({
    price: existing.sl != null ? fmtIn(existing.sl) : "",
    gain:
      existing.sl != null ? fmtGain(gainFromPrice(existing.sl, "pct"), "pct") : "",
    unit: "pct" as "pct" | "usd",
  });
  const [error, setError] = useState<string | null>(null);
  // Mark-for-cancellation (deferred to Confirm, batched with any other change).
  const [cancelTp, setCancelTp] = useState(false);
  const [cancelSl, setCancelSl] = useState(false);

  // Esc closes.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const clean = (v: string) => v.replace(/[^0-9.]/g, "");
  const onPrice = (which: "tp" | "sl", v: string) => {
    const cv = clean(v);
    const set = which === "tp" ? setTp : setSl;
    set((s) => {
      const n = Number(cv);
      const gain = cv.trim() && Number.isFinite(n) ? fmtGain(gainFromPrice(n, s.unit), s.unit) : "";
      return { ...s, price: cv, gain };
    });
  };
  const onGain = (which: "tp" | "sl", v: string) => {
    const cv = clean(v.replace("−", "").replace("-", "")) ? v.replace(/[^0-9.\-−]/g, "") : "";
    const set = which === "tp" ? setTp : setSl;
    set((s) => {
      const n = Number(cv.replace("−", "-"));
      const price = cv.trim() && Number.isFinite(n) ? fmtIn(priceFromGain(n, s.unit)) : "";
      return { ...s, gain: cv, price };
    });
  };
  const toggleUnit = (which: "tp" | "sl") => {
    const set = which === "tp" ? setTp : setSl;
    set((s) => {
      const nextUnit = s.unit === "pct" ? "usd" : "pct";
      const p = num(s.price);
      const gain = s.price.trim() && Number.isFinite(p) ? fmtGain(gainFromPrice(p, nextUnit), nextUnit) : "";
      return { ...s, unit: nextUnit, gain };
    });
  };

  const tpVal = tp.price.trim() ? num(tp.price) : null;
  const slVal = sl.price.trim() ? num(sl.price) : null;
  const ok = (v: number | null) => v != null && Number.isFinite(v) && v > 0;
  const pnlAt = (v: number | null) => (ok(v) ? ((v as number) - entry) * signedSize : null);
  const roeAt = (v: number | null) => {
    const p = pnlAt(v);
    return p != null && margin && margin > 0 ? (p / margin) * 100 : null;
  };

  // A leg is a "place" only when it's a valid value that DIFFERS from the one
  // already resting — the modal pre-fills the existing trigger, so leaving it
  // untouched must not re-submit an identical order (and, when the other leg is
  // being cancelled, keeps this one a true no-op so Confirm reads "Cancel …").
  // A leg marked for cancellation is greyed out and never a place.
  const tpChanged = tp.price !== (existing.tp != null ? fmtIn(existing.tp) : "");
  const slChanged = sl.price !== (existing.sl != null ? fmtIn(existing.sl) : "");
  const tpPlace = !cancelTp && ok(tpVal) && tpChanged;
  const slPlace = !cancelSl && ok(slVal) && slChanged;

  // Validation (skip a leg being cancelled).
  const problems: string[] = [];
  if (tpPlace && mark != null && (isLong ? (tpVal as number) <= mark : (tpVal as number) >= mark))
    problems.push(`Take profit must be ${isLong ? "above" : "below"} mark (${fmtPx(mark)}).`);
  if (slPlace && mark != null && (isLong ? (slVal as number) >= mark : (slVal as number) <= mark))
    problems.push(`Stop loss must be ${isLong ? "below" : "above"} mark (${fmtPx(mark)}).`);
  let liqWarn: string | null = null;
  if (slPlace && liq != null && (isLong ? (slVal as number) <= liq : (slVal as number) >= liq))
    liqWarn = `Stop is past liquidation (${fmtPx(liq)}) — it may never trigger.`;

  const notionalAt = (v: number | null) => (ok(v) ? size * (v as number) : 0);
  const feeTotal =
    ((tpPlace ? notionalAt(tpVal) : 0) + (slPlace ? notionalAt(slVal) : 0)) *
    (takerFee + builderRate);

  const anyPlace = tpPlace || slPlace;
  const anyCancel = cancelTp || cancelSl;
  const canConfirm =
    placementEnabled && (anyPlace || anyCancel) && problems.length === 0 && !busy;

  // Button intent: a single leg (place or cancel) wears that leg's side colour;
  // a mixed action (both legs, or place one + cancel the other) is neutral.
  const tpActing = tpPlace || cancelTp;
  const slActing = slPlace || cancelSl;
  const singleLeg: "tp" | "sl" | null =
    tpActing && !slActing ? "tp" : slActing && !tpActing ? "sl" : null;
  const confirmLabel =
    anyCancel && !anyPlace
      ? cancelTp && cancelSl
        ? "Cancel TP & SL"
        : cancelTp
          ? "Cancel TP"
          : "Cancel SL"
      : "Confirm";

  const submit = async () => {
    setError(null);
    const res = await onSet(
      position,
      {
        tp: cancelTp ? "cancel" : tpPlace ? tpVal : null,
        sl: cancelSl ? "cancel" : slPlace ? slVal : null,
      },
      { tpOrderId: existing.tpOrderId, slOrderId: existing.slOrderId },
    );
    if (res.ok) onClose();
    else setError(res.error ?? "Action failed.");
  };

  const sym = perpName(position.s);

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
            <span className="text-[15px] font-semibold text-fg">Take Profit &amp; Stop Loss</span>
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
          {/* Summary card */}
          <div className="mb-4 rounded-lg border border-line bg-surface-2/60 p-3 text-[12px]">
            <SumRow
              label="Current Position"
              value={`${isLong ? "+" : "−"}${absSize.toLocaleString(undefined, { maximumFractionDigits: qDp })} ${baseOf(position.s)}`}
              tone={isLong ? "pos" : "neg"}
            />
            <SumRow label="Avg. Entry Price" value={fmtPx(entry)} />
            <SumRow label="Mark Price" value={mark != null ? fmtPx(mark) : "—"} />
          </div>

          <Section
            kind="tp"
            title="Take Profit"
            gainLabel="Gain"
            state={tp}
            onPrice={(v) => onPrice("tp", v)}
            onGain={(v) => onGain("tp", v)}
            onToggle={() => toggleUnit("tp")}
            pnl={pnlAt(tpVal)}
            roe={roeAt(tpVal)}
            autoFocus={focus === "tp"}
            hasExisting={existing.tpOrderId != null}
            cancelled={cancelTp}
            onCancelClick={() => setCancelTp(true)}
            onUndo={() => setCancelTp(false)}
            money={money}
          />
          <Section
            kind="sl"
            title="Stop Loss"
            gainLabel="Loss"
            state={sl}
            onPrice={(v) => onPrice("sl", v)}
            onGain={(v) => onGain("sl", v)}
            onToggle={() => toggleUnit("sl")}
            pnl={pnlAt(slVal)}
            roe={roeAt(slVal)}
            autoFocus={focus === "sl"}
            hasExisting={existing.slOrderId != null}
            cancelled={cancelSl}
            onCancelClick={() => setCancelSl(true)}
            onUndo={() => setCancelSl(false)}
            money={money}
          />

          <div className="my-4 border-t border-line" />

          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-fg-muted" title="Execute the trigger as a limit order at the trigger price instead of a market order.">
            <input type="checkbox" checked={asLimit} onChange={(e) => setAsLimit(e.target.checked)} className="h-3.5 w-3.5 accent-accent" />
            Limit
            <span className="text-[10px] text-fg-dim">executes at the trigger price (not market)</span>
          </label>
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12px] text-fg-muted" title="Apply TP/SL to part of the position instead of the whole size.">
            <input type="checkbox" checked={configureSize} onChange={(e) => setConfigureSize(e.target.checked)} className="h-3.5 w-3.5 accent-accent" />
            Configure size
            <span className="text-[10px] text-fg-dim">default = full position</span>
          </label>
          {configureSize ? (
            <div className="mt-2 flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={100}
                value={sizePct}
                onChange={(e) => setSizePct(Number(e.target.value))}
                className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-surface-2"
                style={{ accentColor: isLong ? "#0ecb81" : "#f6465d" }}
              />
              <span className="w-28 text-right text-[11px] tabular-nums text-fg-muted">
                {sizePct}% · {size.toLocaleString(undefined, { maximumFractionDigits: qDp })} {baseOf(position.s)}
              </span>
            </div>
          ) : null}

          {problems.map((p, i) => (
            <p key={i} className="mt-2 text-[11px] text-negative">{p}</p>
          ))}
          {liqWarn ? <p className="mt-2 text-[11px] text-[#e0a53f]">{liqWarn}</p> : null}
          {error ? <p className="mt-2 text-[11px] text-negative">{error}</p> : null}
        </div>

        {/* Footer: fee line + Confirm */}
        <div className="shrink-0 border-t border-line px-5 py-3">
          <div className="mb-2 flex items-center justify-between text-[11px] text-fg-dim">
            <span>Est. fee (exchange + builder)</span>
            <span className="font-[var(--font-jetbrains-mono)] tabular-nums text-fg-muted">
              {anyPlace ? `$${feeTotal.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}` : "—"}
            </span>
          </div>
          {!placementEnabled ? (
            <p className="mb-2 text-center text-[10px] text-[#e0a53f]">
              TP/SL placement being fixed — temporarily disabled.
            </p>
          ) : null}
          {/* Trade action: neutral primary, or the leg's side colour for a
              single TP/SL. No Helix accent on an order action. */}
          <button
            onClick={submit}
            disabled={!canConfirm}
            className={cn(
              "w-full rounded-lg py-2.5 text-[14px] font-semibold transition-colors",
              canConfirm ? "hover:opacity-90" : "cursor-not-allowed bg-surface-2 text-fg-dim",
            )}
            style={
              canConfirm
                ? singleLeg === "tp"
                  ? { backgroundColor: "#0ecb81", color: "#0b0e11" }
                  : singleLeg === "sl"
                    ? { backgroundColor: "#f6465d", color: "#0b0e11" }
                    : { backgroundColor: "var(--accent-trade)", color: "#ffffff" }
                : undefined
            }
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function SumRow({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
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

function Section({
  kind,
  title,
  gainLabel,
  state,
  onPrice,
  onGain,
  onToggle,
  pnl,
  roe,
  autoFocus,
  hasExisting,
  cancelled,
  onCancelClick,
  onUndo,
  money,
}: {
  kind: "tp" | "sl";
  title: string;
  gainLabel: string;
  state: { price: string; gain: string; unit: "pct" | "usd" };
  onPrice: (v: string) => void;
  onGain: (v: string) => void;
  onToggle: () => void;
  pnl: number | null;
  roe: number | null;
  autoFocus?: boolean;
  /** A trigger for this leg is resting on SoDEX (so it can be cancelled). */
  hasExisting: boolean;
  /** This leg is marked for cancellation on Confirm. */
  cancelled: boolean;
  onCancelClick: () => void;
  onUndo: () => void;
  money: (v: number) => string;
}) {
  const accent = kind === "tp" ? "text-positive" : "text-negative";
  const legShort = kind === "tp" ? "TP" : "SL";
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between">
        <span className={cn("text-[12px] font-medium", accent)}>{title}</span>
        {cancelled ? (
          <span className="flex items-center gap-2 text-[10px]">
            <span className="text-[#e0a53f]">Will be cancelled</span>
            <button
              onClick={onUndo}
              className="text-fg-muted underline-offset-2 hover:text-fg hover:underline"
            >
              Undo
            </button>
          </span>
        ) : hasExisting ? (
          <button
            onClick={onCancelClick}
            className="rounded border border-transparent px-1.5 py-0.5 text-[10px] font-medium text-negative transition-colors hover:border-negative/50 hover:bg-negative/5"
          >
            ✕ Cancel {legShort}
          </button>
        ) : null}
      </div>
      <div
        className={cn(
          "grid grid-cols-2 gap-2",
          cancelled && "pointer-events-none opacity-40",
        )}
      >
        {/* Price */}
        <div className="flex items-center rounded-md border border-line bg-surface-2 px-2.5 focus-within:border-[#3a4452]">
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-fg-dim">Price</span>
          <input
            autoFocus={autoFocus}
            disabled={cancelled}
            inputMode="decimal"
            value={state.price}
            onChange={(e) => onPrice(e.target.value)}
            placeholder="$0.00"
            className="w-full bg-transparent py-2 text-right text-[13px] tabular-nums text-fg outline-none placeholder:text-fg-dim"
          />
        </div>
        {/* Gain/Loss */}
        <div className="flex items-center rounded-md border border-line bg-surface-2 px-2.5 focus-within:border-[#3a4452]">
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-fg-dim">{gainLabel}</span>
          <input
            disabled={cancelled}
            inputMode="decimal"
            value={state.gain}
            onChange={(e) => onGain(e.target.value)}
            placeholder="0.00"
            className="w-full bg-transparent py-2 text-right text-[13px] tabular-nums text-fg outline-none placeholder:text-fg-dim"
          />
          <button
            onClick={onToggle}
            title="Switch % / $"
            className="ml-1 shrink-0 rounded border border-line px-1 text-[10px] text-fg-muted hover:text-fg"
          >
            {state.unit === "pct" ? "%" : "$"} ⇄
          </button>
        </div>
      </div>
      {!cancelled && pnl != null ? (
        <div className="mt-1 flex items-center justify-between text-[10px]">
          <span className={cn("tabular-nums", pnl >= 0 ? "text-positive" : "text-negative")}>
            Est. PnL {money(pnl)}
          </span>
          {roe != null ? (
            <span className="tabular-nums text-fg-dim">
              {roe >= 0 ? "+" : "−"}
              {Math.abs(roe).toFixed(2)}% ROE
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
