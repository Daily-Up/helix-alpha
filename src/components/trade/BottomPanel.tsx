"use client";

/**
 * BottomPanel — the terminal's Positions / Open Orders / Trade History /
 * Funding / Order History tabs, wired to the live perps account state
 * (fetched in the parent). A toolbar on the right of the tab bar filters to
 * the current market and closes every position. Disconnected or empty tabs
 * show a short empty state with a Connect SoDEX CTA.
 */

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { AssetLogo } from "@/components/ui/AssetLogo";
import {
  SodexSide,
  SodexOrderType,
  type SodexPerpsAccountState,
  type SodexOpenOrder,
} from "@/lib/sodex-onchain/types";

export const BOTTOM_TABS = [
  "Positions",
  "Open Orders",
  "Trade History",
  "Funding",
  "Order History",
] as const;
export type BottomTab = (typeof BOTTOM_TABS)[number];

// Plain positive $ (notional, margin, prices) — no sign.
const money = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : `$${v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
// Signed $ with the sign BEFORE the currency symbol (−$0.05, +$0.10); a
// non-zero magnitude under a cent collapses to "<$0.01" keeping its sign.
const signedMoney = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v < 0 ? "−" : "+";
  const abs = Math.abs(v);
  if (abs > 0 && abs < 0.01) return `${sign}<$0.01`;
  return `${sign}$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const qtyFmt = (v: number) =>
  v.toLocaleString(undefined, { maximumFractionDigits: 6 });
const two = (n: number) => String(n).padStart(2, "0");
const fmtTime = (t: number) => {
  const d = new Date(t < 1e12 ? t * 1000 : t); // accept seconds or ms
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};
// Display names use the -PERP convention everywhere, matching the header.
const perpName = (s: string) => s.replace(/-USDC?$/i, "-PERP");
const baseOf = (s: string) => s.split("-")[0] || s;
const marginModeLabel = (m?: string) =>
  m ? m.charAt(0).toUpperCase() + m.slice(1).toLowerCase() : null;

type Position = NonNullable<SodexPerpsAccountState["P"]>[number];

export type TpSlCtx = {
  /** Selected market's rules (tick/step/precision/fee) — null until loaded. */
  rules: {
    symbolID: number;
    tickSize: number;
    stepSize: number;
    pricePrecision: number;
    quantityPrecision: number;
    takerFee: number;
  } | null;
  builderRate: number;
  busy: boolean;
  /** Placement is disabled until the SoDEX trigger payload fix is approved. */
  placementEnabled: boolean;
  /** Place/modify TP & SL (place new, then cancel old). */
  onSet: (
    pos: Position,
    next: { tp: number | null; sl: number | null },
    existing: { tpOrderId: number | null; slOrderId: number | null },
  ) => Promise<{ ok: boolean; error?: string }>;
};

export function BottomPanel({
  tab,
  setTab,
  account,
  openOrders,
  onCancel,
  cancelBusy,
  onSelectSymbol,
  onClosePosition,
  onCloseAll,
  closeAllBusy,
  markBySymbol,
  selectedSymbol,
  tpsl,
  ready,
  digits,
}: {
  tab: BottomTab;
  setTab: (t: BottomTab) => void;
  account: SodexPerpsAccountState | null;
  openOrders: SodexOpenOrder[];
  onCancel: (orderIDs: number[]) => void;
  cancelBusy: boolean;
  /** Switch the terminal to a position's market (click the market name). */
  onSelectSymbol: (sodexSymbol: string) => void;
  /** Close/limit-close a single position through the order ticket. */
  onClosePosition: (position: Position, type: "market" | "limit") => void;
  /** Market reduce-only close EVERY open position (through the live path). */
  onCloseAll: (positions: Position[]) => void;
  closeAllBusy: boolean;
  /** Live mark price keyed by sodex symbol (all open-position symbols). */
  markBySymbol: Record<string, number>;
  /** Currently-selected market symbol, for the "Current market only" filter. */
  selectedSymbol: string | null;
  /** TP/SL placement context (selected market rules + the place/modify call). */
  tpsl: TpSlCtx;
  ready: boolean;
  digits: number;
}) {
  const [currentOnly, setCurrentOnly] = useState(false);
  const [closeAllOpen, setCloseAllOpen] = useState(false);

  const allPositions = (account?.P ?? []).filter((p) => Number(p.sz) !== 0);
  const sel = (selectedSymbol ?? "").toUpperCase();
  const matchesSel = (s: string) =>
    !currentOnly || s.toUpperCase() === sel || baseOf(s).toUpperCase() === baseOf(sel);
  const positions = allPositions.filter((p) => matchesSel(p.s));
  const orders = openOrders.filter((o) => matchesSel(o.symbol));

  const counts: Record<BottomTab, number> = {
    Positions: positions.length,
    "Open Orders": orders.length,
    "Trade History": 0,
    Funding: 0,
    "Order History": 0,
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-4 border-b border-line px-4 py-2 text-[12px]">
        <div className="flex items-center gap-4 overflow-x-auto">
          {BOTTOM_TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap transition-colors",
                tab === t ? "font-medium text-fg" : "text-fg-dim hover:text-fg-muted",
              )}
            >
              {t}
              {counts[t] > 0 ? (
                <span className="rounded bg-surface-2 px-1 text-[10px] tabular-nums text-fg-muted">
                  {counts[t]}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {/* Toolbar — right side of the tab bar */}
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-fg-muted">
            <input
              type="checkbox"
              checked={currentOnly}
              onChange={(e) => setCurrentOnly(e.target.checked)}
              className="h-3 w-3 accent-accent"
            />
            Current market only
          </label>
          <button
            onClick={() => setCloseAllOpen(true)}
            disabled={allPositions.length === 0 || closeAllBusy}
            className="rounded border border-negative/50 px-2 py-0.5 text-[11px] font-medium text-negative transition-colors hover:bg-negative/10 disabled:opacity-40"
          >
            {closeAllBusy ? "Closing…" : "Close All"}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!ready ? (
          <Empty cta>Connect a SoDEX wallet to view your {tab.toLowerCase()}.</Empty>
        ) : tab === "Positions" ? (
          positions.length === 0 ? (
            <Empty>No open positions.</Empty>
          ) : (
            <PositionsView
              positions={positions}
              orders={openOrders}
              digits={digits}
              markBySymbol={markBySymbol}
              selectedSymbol={selectedSymbol}
              tpsl={tpsl}
              onSelect={onSelectSymbol}
              onClose={onClosePosition}
            />
          )
        ) : tab === "Open Orders" ? (
          orders.length === 0 ? (
            <Empty>No open orders.</Empty>
          ) : (
            <OpenOrders orders={orders} onCancel={onCancel} busy={cancelBusy} digits={digits} />
          )
        ) : tab === "Trade History" ? (
          // TODO: wire to /api/sodex/my-trades (Helix's executed-trade log).
          <Empty>Trade history coming soon.</Empty>
        ) : tab === "Funding" ? (
          // TODO: SoDEX exposes no per-position funding-payment endpoint yet.
          // Wire here once /accounts/{addr}/funding (or similar) ships.
          <Empty>
            Funding payments aren&apos;t available from SoDEX yet. (TODO: wire a
            funding-history endpoint when one exists.)
          </Empty>
        ) : (
          // Order History — TODO: no SoDEX filled/cancelled/rejected history
          // endpoint yet; fall back to an empty state.
          <Empty>
            Order history isn&apos;t available from SoDEX yet. (TODO: wire a
            filled / cancelled / rejected orders endpoint when one exists.)
          </Empty>
        )}
      </div>

      {closeAllOpen ? (
        <CloseAllConfirm
          positions={allPositions}
          markBySymbol={markBySymbol}
          digits={digits}
          busy={closeAllBusy}
          onConfirm={() => {
            onCloseAll(allPositions);
            setCloseAllOpen(false);
          }}
          onCancel={() => setCloseAllOpen(false)}
        />
      ) : null}
    </div>
  );
}

function Empty({ children, cta }: { children: React.ReactNode; cta?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-[12px] text-fg-dim">
      <span className="max-w-sm">{children}</span>
      {cta ? (
        <Link
          href="/settings/connect-sodex"
          className="rounded-md border border-accent/50 bg-accent/15 px-3 py-1.5 text-[12px] font-medium text-accent-2 transition-colors hover:bg-accent/25"
        >
          Connect SoDEX
        </Link>
      ) : null}
    </div>
  );
}

// Market | Amount | Value | Avg Open | Mark | uPnL | Liq | Margin | Funding | TP/SL | Close.
// minmax() so the columns spread to fill a wide panel and the table scrolls
// (parent overflow-auto) rather than clipping when the panel is narrow.
const POS_COLS =
  "minmax(172px,1.9fr) minmax(104px,1.15fr) minmax(88px,1fr) minmax(92px,1fr) minmax(92px,1fr) minmax(128px,1.5fr) minmax(98px,1.05fr) minmax(84px,1fr) minmax(76px,0.85fr) minmax(104px,1.1fr) minmax(74px,0.8fr)";

/** Read a (possibly runtime-only) stopPrice off an open order. */
function stopPriceOf(o: SodexOpenOrder): number | null {
  const sp = (o as { stopPrice?: string }).stopPrice;
  const n = sp != null ? Number(sp) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function PositionsView({
  positions,
  orders,
  digits,
  markBySymbol,
  selectedSymbol,
  tpsl,
  onSelect,
  onClose,
}: {
  positions: Position[];
  orders: SodexOpenOrder[];
  digits: number;
  markBySymbol: Record<string, number>;
  selectedSymbol: string | null;
  tpsl: TpSlCtx;
  onSelect: (sodexSymbol: string) => void;
  onClose: (position: Position, type: "market" | "limit") => void;
}) {
  // Which row has its ⋯ (close options) or ✎ (TP/SL) popover open.
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const [tpslRow, setTpslRow] = useState<string | null>(null);
  const px = (v: number) =>
    v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const HEAD = [
    "Market",
    "Amount",
    "Value",
    "Avg Open",
    "Mark",
    "uPnL",
    "Liquidation",
    "Margin",
    "Funding",
    "TP/SL",
    "",
  ];
  return (
    <div className="min-w-[1040px] text-[11.5px]">
      <div
        className="grid gap-2 border-b border-line px-4 py-1.5 text-[9px] uppercase tracking-wider text-fg-dim"
        style={{ gridTemplateColumns: POS_COLS }}
      >
        {HEAD.map((h, i) => (
          <span key={i} className={i === 0 ? "" : "text-right"}>
            {h}
          </span>
        ))}
      </div>
      {positions.map((p) => {
        const key = `${p.i}-${p.s}`;
        const sz = Number(p.sz);
        const abs = Math.abs(sz);
        const isLong = sz >= 0;
        const entry = Number(p.ep);
        const ur = p.ur != null ? Number(p.ur) : null;
        const lev = p.l ?? null;
        const mode = marginModeLabel(p.m);
        const mark = markBySymbol[p.s.toUpperCase()] ?? null;
        const liq = p.lp && Number(p.lp) > 0 ? Number(p.lp) : null;
        const value = mark != null ? abs * mark : null; // notional = size × mark
        const margin = lev && lev > 0 ? (abs * entry) / lev : null;
        const roe = ur != null && margin && margin > 0 ? (ur / margin) * 100 : null;
        const liqWarn =
          liq != null && mark != null && mark > 0 && Math.abs(mark - liq) / mark <= 0.1;

        // TP/SL display: reduce-only stop orders for this symbol (selected
        // market only — openOrders covers the selected symbol). stopType isn't
        // in the public type, so classify by trigger vs entry: a stop above
        // entry on a long = TP, below = SL (mirrored for shorts).
        const stopOrders = orders.filter(
          (o) =>
            o.symbol.toUpperCase() === p.s.toUpperCase() &&
            o.reduceOnly &&
            stopPriceOf(o) != null,
        );
        const tpOrder =
          stopOrders.find((o) => {
            const t = stopPriceOf(o) as number;
            return isLong ? t > entry : t < entry;
          }) ?? null;
        const slOrder =
          stopOrders.find((o) => {
            const t = stopPriceOf(o) as number;
            return isLong ? t < entry : t > entry;
          }) ?? null;
        const tp = tpOrder ? stopPriceOf(tpOrder) : null;
        const sl = slOrder ? stopPriceOf(slOrder) : null;
        // Resting stop size (to warn when the position has since drifted).
        const existingStopQty =
          tpOrder?.origQty != null
            ? Number(tpOrder.origQty)
            : slOrder?.origQty != null
              ? Number(slOrder.origQty)
              : null;
        // TP/SL editing needs the selected market's rules (tick/step/fees).
        const canEditTpSl =
          tpsl.rules != null &&
          p.s.toUpperCase() === (selectedSymbol ?? "").toUpperCase();

        return (
          <div
            key={key}
            className="grid items-center gap-2 px-4 py-2 font-[var(--font-jetbrains-mono)] tabular-nums transition-colors hover:bg-surface-2/50"
            style={{ gridTemplateColumns: POS_COLS }}
          >
            {/* Market: icon + symbol + side / leverage / margin-mode badges */}
            <button
              onClick={() => onSelect(p.s)}
              className="flex min-w-0 items-center gap-2 text-left hover:opacity-80"
              title="Switch the chart to this market"
            >
              <AssetLogo symbol={p.s} size={18} />
              <div className="flex min-w-0 flex-col gap-0.5 leading-tight">
                <span className="truncate font-medium text-fg">{perpName(p.s)}</span>
                <div className="flex items-center gap-1">
                  <span
                    className={cn(
                      "rounded px-1 text-[8.5px] font-semibold uppercase",
                      isLong ? "bg-positive/15 text-positive" : "bg-negative/15 text-negative",
                    )}
                  >
                    {isLong ? "Long" : "Short"}
                  </span>
                  {lev != null ? (
                    <span className="rounded bg-surface-2 px-1 text-[8.5px] tabular-nums text-fg-muted">
                      {lev}×
                    </span>
                  ) : null}
                  {mode ? (
                    <span className="rounded bg-surface-2 px-1 text-[8.5px] text-fg-muted">
                      {mode}
                    </span>
                  ) : null}
                </div>
              </div>
            </button>

            {/* Amount */}
            <span className={cn("text-right", isLong ? "text-positive" : "text-negative")}>
              {qtyFmt(abs)} <span className="text-fg-dim">{baseOf(p.s)}</span>
            </span>
            {/* Value (notional) */}
            <span className="text-right text-fg">{value != null ? money(value) : "—"}</span>
            {/* Avg Open */}
            <span className="text-right text-fg-muted">{px(entry)}</span>
            {/* Mark */}
            <span className="text-right">{mark != null ? px(mark) : "—"}</span>
            {/* uPnL */}
            <span
              className={cn(
                "text-right",
                ur == null ? "text-fg-dim" : ur >= 0 ? "text-positive" : "text-negative",
              )}
            >
              {ur == null
                ? "—"
                : `${signedMoney(ur)}${roe != null ? ` (${roe >= 0 ? "+" : "−"}${Math.abs(roe).toFixed(2)}%)` : ""}`}
            </span>
            {/* Liquidation */}
            <span
              className={cn("text-right", liqWarn ? "text-[#e0a53f]" : "text-fg-muted")}
              title={
                liq == null
                  ? "No liquidation price at current account equity"
                  : liqWarn
                    ? "Mark is within 10% of liquidation"
                    : undefined
              }
            >
              {liq != null ? px(liq) : "—"}
            </span>
            {/* Margin */}
            <span className="text-right text-fg-muted">
              {margin != null ? money(margin) : "—"}
            </span>
            {/* Funding */}
            <span
              className="text-right text-fg-dim"
              title="Per-position funding isn't exposed by SoDEX yet"
            >
              —
            </span>
            {/* TP/SL — display + edit (placement pending) */}
            <span className="relative flex items-center justify-end gap-1 text-right">
              <span className="tabular-nums text-fg-muted">
                {tp != null || sl != null ? (
                  <>
                    <span className="text-positive">{tp != null ? px(tp) : "—"}</span>
                    <span className="text-fg-dim"> / </span>
                    <span className="text-negative">{sl != null ? px(sl) : "—"}</span>
                  </>
                ) : (
                  "—"
                )}
              </span>
              <button
                onClick={() => setTpslRow(tpslRow === key ? null : key)}
                className="rounded border border-line px-1 text-[10px] text-fg-dim transition-colors hover:text-fg"
                title="Set TP / SL"
              >
                ✎
              </button>
              {tpslRow === key ? (
                <TpSlPopover
                  position={p}
                  entry={entry}
                  absSize={abs}
                  isLong={isLong}
                  mark={mark}
                  liq={liq}
                  margin={margin}
                  tp={tp}
                  sl={sl}
                  tpOrderId={tpOrder?.orderID ?? null}
                  slOrderId={slOrder?.orderID ?? null}
                  existingQty={existingStopQty}
                  canEdit={canEditTpSl}
                  tpsl={tpsl}
                  digits={digits}
                  onSelectMarket={() => {
                    onSelect(p.s);
                    setTpslRow(null);
                  }}
                  onClose={() => setTpslRow(null)}
                />
              ) : null}
            </span>
            {/* Close (×) + ⋯ menu (Limit close) */}
            <span className="relative flex items-center justify-end gap-1">
              <button
                onClick={() => onClose(p, "market")}
                className="rounded border border-negative/50 px-1.5 text-[12px] leading-5 text-negative transition-colors hover:bg-negative/10"
                title="Market close (reduce-only, full size)"
              >
                ×
              </button>
              <button
                onClick={() => setMenuRow(menuRow === key ? null : key)}
                className="rounded border border-line px-1 text-[12px] leading-5 text-fg-dim transition-colors hover:text-fg"
                title="More"
              >
                ⋯
              </button>
              {menuRow === key ? (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setMenuRow(null)} />
                  <div className="absolute right-0 top-full z-40 mt-1 w-28 overflow-hidden rounded-md border border-line bg-surface shadow-xl">
                    <button
                      onClick={() => {
                        onClose(p, "limit");
                        setMenuRow(null);
                      }}
                      className="block w-full px-3 py-1.5 text-left text-[11px] text-fg-muted hover:bg-surface-2 hover:text-fg"
                    >
                      Limit close
                    </button>
                  </div>
                </>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** TP/SL editor popover — validation, est. PnL + fees, and a confirm step.
 *  Editing is enabled only for the selected market (its rules carry tick/step
 *  + fees); other markets show the current triggers + a switch button. */
function TpSlPopover({
  position,
  entry,
  absSize,
  isLong,
  mark,
  liq,
  margin,
  tp,
  sl,
  tpOrderId,
  slOrderId,
  existingQty,
  canEdit,
  tpsl,
  digits,
  onSelectMarket,
  onClose,
}: {
  position: Position;
  entry: number;
  absSize: number;
  isLong: boolean;
  mark: number | null;
  liq: number | null;
  margin: number | null;
  tp: number | null;
  sl: number | null;
  tpOrderId: number | null;
  slOrderId: number | null;
  existingQty: number | null;
  canEdit: boolean;
  tpsl: TpSlCtx;
  digits: number;
  onSelectMarket: () => void;
  onClose: () => void;
}) {
  const fmtPx = (v: number) =>
    v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const [tpInput, setTpInput] = useState(tp != null ? String(tp) : "");
  const [slInput, setSlInput] = useState(sl != null ? String(sl) : "");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rules = tpsl.rules;
  const signed = isLong ? absSize : -absSize;
  const tpVal = tpInput.trim() ? Number(tpInput) : null;
  const slVal = slInput.trim() ? Number(slInput) : null;
  const valid = (v: number | null) => v != null && Number.isFinite(v) && v > 0;

  // Validation (condition 3): long TP>mark / SL<mark; short reversed.
  const problems: string[] = [];
  if (valid(tpVal) && mark != null && (isLong ? (tpVal as number) <= mark : (tpVal as number) >= mark))
    problems.push(`Take profit must be ${isLong ? "above" : "below"} mark (${fmtPx(mark)}).`);
  if (valid(slVal) && mark != null && (isLong ? (slVal as number) >= mark : (slVal as number) <= mark))
    problems.push(`Stop loss must be ${isLong ? "below" : "above"} mark (${fmtPx(mark)}).`);
  // SL beyond liquidation → would never trigger (non-blocking warning).
  let liqWarn: string | null = null;
  if (valid(slVal) && liq != null && (isLong ? (slVal as number) <= liq : (slVal as number) >= liq))
    liqWarn = `Stop is past liquidation (${fmtPx(liq)}) — it may never trigger.`;
  // Position size drifted from the resting TP/SL size (condition 1 fallback).
  const step = rules && rules.stepSize > 0 ? rules.stepSize : 1e-9;
  const sizeDrift = existingQty != null && Math.abs(existingQty - absSize) > step / 2;

  const pnlAt = (t: number | null) => (valid(t) ? ((t as number) - entry) * signed : null);
  const feeAt = (t: number | null) => {
    if (!valid(t) || !rules) return null;
    const notional = absSize * (t as number);
    return { ex: notional * rules.takerFee, bu: notional * tpsl.builderRate };
  };
  const pct = (p: number | null) => (p != null && margin && margin > 0 ? (p / margin) * 100 : null);

  const changed = tpVal !== tp || slVal !== sl;
  const canReview =
    canEdit && problems.length === 0 && changed && (valid(tpVal) || valid(slVal));

  const submit = async () => {
    setError(null);
    const res = await tpsl.onSet(
      position,
      { tp: valid(tpVal) ? tpVal : null, sl: valid(slVal) ? slVal : null },
      { tpOrderId, slOrderId },
    );
    if (res.ok) onClose();
    else {
      setError(res.error ?? "Placement failed.");
      setConfirming(false);
    }
  };
  const resize = async () => {
    setError(null);
    const res = await tpsl.onSet(position, { tp, sl }, { tpOrderId, slOrderId });
    if (res.ok) onClose();
    else setError(res.error ?? "Resize failed.");
  };

  const sign = (v: number) => (v < 0 ? "−" : "+");
  const money2 = (v: number) =>
    `${sign(v)}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute right-0 top-full z-40 mt-1 w-64 rounded-md border border-line bg-surface p-3 text-left shadow-xl">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-medium text-fg">Take Profit / Stop Loss</span>
          <span className="text-[9px] text-fg-dim">{perpName(position.s)}</span>
        </div>

        {!canEdit ? (
          <div className="flex flex-col gap-2">
            <div className="flex justify-between text-[11px] tabular-nums">
              <span className="text-positive">TP {tp != null ? fmtPx(tp) : "—"}</span>
              <span className="text-negative">SL {sl != null ? fmtPx(sl) : "—"}</span>
            </div>
            <button
              onClick={onSelectMarket}
              className="rounded border border-line py-1 text-[11px] text-fg-muted transition-colors hover:text-fg"
            >
              Switch to {perpName(position.s)} to edit
            </button>
          </div>
        ) : confirming ? (
          <div className="flex flex-col gap-1.5 text-[11px]">
            {([
              ["Take profit", tpVal, "text-positive"],
              ["Stop loss", slVal, "text-negative"],
            ] as const).map(([label, v, cls]) =>
              valid(v) ? (
                <div key={label} className="rounded border border-line px-2 py-1">
                  <div className="flex items-center justify-between">
                    <span className={cls}>{label}</span>
                    <span className="tabular-nums text-fg">{fmtPx(v as number)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between text-[10px] text-fg-dim">
                    <span>Est. PnL</span>
                    <span
                      className={cn(
                        "tabular-nums",
                        (pnlAt(v) ?? 0) >= 0 ? "text-positive" : "text-negative",
                      )}
                    >
                      {pnlAt(v) != null
                        ? `${money2(pnlAt(v) as number)}${pct(pnlAt(v)) != null ? ` (${sign(pct(pnlAt(v)) as number)}${Math.abs(pct(pnlAt(v)) as number).toFixed(2)}%)` : ""}`
                        : "—"}
                    </span>
                  </div>
                  {feeAt(v) ? (
                    <div className="flex items-center justify-between text-[10px] text-fg-dim">
                      <span>Fee (taker + builder)</span>
                      <span className="tabular-nums">
                        ${(feeAt(v)!.ex + feeAt(v)!.bu).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}
                      </span>
                    </div>
                  ) : null}
                </div>
              ) : null,
            )}
            <p className="text-[9px] text-fg-dim">
              Reduce-only market stop, mark-triggered, size {absSize} {baseOf(position.s)}. Real funds.
            </p>
            <div className="flex gap-2">
              <button
                onClick={submit}
                disabled={tpsl.busy}
                className="flex-1 rounded bg-accent/20 py-1 text-[11px] font-semibold text-accent-2 hover:bg-accent/30 disabled:opacity-60"
              >
                {tpsl.busy ? "Placing…" : "Confirm"}
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={tpsl.busy}
                className="flex-1 rounded border border-line py-1 text-[11px] text-fg-muted hover:text-fg"
              >
                Back
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-positive">Take profit</span>
              <input
                value={tpInput}
                onChange={(e) => setTpInput(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="Trigger price"
                className="rounded border border-line bg-surface-2 px-2 py-1 text-[11px] tabular-nums text-fg outline-none placeholder:text-fg-dim focus:border-[#3a4452]"
              />
              {valid(tpVal) && pnlAt(tpVal) != null ? (
                <span className={cn("text-[9px] tabular-nums", (pnlAt(tpVal) as number) >= 0 ? "text-positive" : "text-negative")}>
                  {money2(pnlAt(tpVal) as number)}
                  {pct(pnlAt(tpVal)) != null ? ` (${sign(pct(pnlAt(tpVal)) as number)}${Math.abs(pct(pnlAt(tpVal)) as number).toFixed(2)}%)` : ""}
                </span>
              ) : null}
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-negative">Stop loss</span>
              <input
                value={slInput}
                onChange={(e) => setSlInput(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="Trigger price"
                className="rounded border border-line bg-surface-2 px-2 py-1 text-[11px] tabular-nums text-fg outline-none placeholder:text-fg-dim focus:border-[#3a4452]"
              />
              {valid(slVal) && pnlAt(slVal) != null ? (
                <span className={cn("text-[9px] tabular-nums", (pnlAt(slVal) as number) >= 0 ? "text-positive" : "text-negative")}>
                  {money2(pnlAt(slVal) as number)}
                  {pct(pnlAt(slVal)) != null ? ` (${sign(pct(pnlAt(slVal)) as number)}${Math.abs(pct(pnlAt(slVal)) as number).toFixed(2)}%)` : ""}
                </span>
              ) : null}
            </label>
            {sizeDrift ? (
              <div className="flex items-center justify-between gap-2 rounded border border-[#e0a53f]/40 bg-[#e0a53f]/10 px-2 py-1 text-[9.5px] text-[#e0a53f]">
                <span>TP/SL size ≠ position</span>
                <button onClick={resize} disabled={tpsl.busy || !tpsl.placementEnabled} className="shrink-0 rounded border border-[#e0a53f]/50 px-1.5 hover:bg-[#e0a53f]/15 disabled:opacity-40">
                  Resize to position
                </button>
              </div>
            ) : null}
            {problems.map((p, i) => (
              <p key={i} className="text-[9.5px] text-negative">{p}</p>
            ))}
            {liqWarn ? <p className="text-[9.5px] text-[#e0a53f]">{liqWarn}</p> : null}
            {!tpsl.placementEnabled ? (
              <p className="text-[9.5px] text-[#e0a53f]">
                TP/SL placement is being fixed — temporarily disabled.
              </p>
            ) : null}
            <button
              onClick={() => setConfirming(true)}
              disabled={!canReview || !tpsl.placementEnabled}
              className="rounded bg-accent/20 py-1 text-[11px] font-semibold text-accent-2 transition-colors hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Review
            </button>
          </div>
        )}
        {error ? <p className="mt-2 text-[10px] text-negative">{error}</p> : null}
      </div>
    </>
  );
}

/** Close-all confirm — lists every position + a total estimated taker fee. */
function CloseAllConfirm({
  positions,
  markBySymbol,
  digits,
  busy,
  onConfirm,
  onCancel,
}: {
  positions: Position[];
  markBySymbol: Record<string, number>;
  digits: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const TAKER = 0.0004; // exchange taker; builder adds 0.0001 → ~0.0005 total.
  const TOTAL_RATE = 0.0005;
  const rows = positions.map((p) => {
    const abs = Math.abs(Number(p.sz));
    const mark = markBySymbol[p.s.toUpperCase()] ?? Number(p.ep);
    const notional = abs * mark;
    return { sym: perpName(p.s), isLong: Number(p.sz) >= 0, abs, base: baseOf(p.s), notional };
  });
  const totalNotional = rows.reduce((s, r) => s + r.notional, 0);
  const estFee = totalNotional * TOTAL_RATE;
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-lg border border-negative/40 bg-surface shadow-2xl">
        <div className="border-b border-line px-4 py-2.5 text-[13px] font-semibold text-fg">
          Close all positions ({positions.length})
        </div>
        <div className="max-h-[220px] overflow-y-auto px-4 py-2">
          {rows.map((r, i) => (
            <div
              key={i}
              className="flex items-center justify-between py-1 font-[var(--font-jetbrains-mono)] text-[11.5px] tabular-nums"
            >
              <span className="flex items-center gap-2">
                <span className={r.isLong ? "text-positive" : "text-negative"}>
                  {r.isLong ? "Long" : "Short"}
                </span>
                <span className="text-fg">{r.sym}</span>
                <span className="text-fg-dim">
                  {qtyFmt(r.abs)} {r.base}
                </span>
              </span>
              <span className="text-fg-muted">{money(r.notional)}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[11.5px]">
          <span className="text-fg-dim">Est. total fee (taker + builder ≈ 0.05%)</span>
          <span className="font-[var(--font-jetbrains-mono)] tabular-nums text-fg">
            {money(estFee, 4)}
          </span>
        </div>
        <p className="px-4 pb-2 text-[10px] text-fg-dim">
          Places a market reduce-only close for each position. Real funds on
          SoDEX mainnet.
        </p>
        <div className="flex gap-2 border-t border-line px-4 py-3">
          <button
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 rounded border border-negative/60 bg-negative/15 py-2 text-[13px] font-semibold text-negative transition-colors hover:bg-negative/25 disabled:opacity-60"
          >
            {busy ? "Closing…" : `Close all ${positions.length}`}
          </button>
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 rounded border border-line py-2 text-[13px] text-fg-muted hover:text-fg"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const OO_COLS = "72px 1fr 1fr 1fr 1fr 64px";

function OpenOrders({
  orders,
  onCancel,
  busy,
  digits,
}: {
  orders: SodexOpenOrder[];
  onCancel: (orderIDs: number[]) => void;
  busy: boolean;
  digits: number;
}) {
  const px = (v?: string) =>
    v != null && Number.isFinite(Number(v))
      ? Number(v).toLocaleString(undefined, {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })
      : "—";
  return (
    <div className="text-[11.5px]">
      <div className="flex items-center justify-between border-b border-line px-4 py-1.5">
        <span className="text-[9px] uppercase tracking-wider text-fg-dim">
          {orders.length} open · {orders[0]?.symbol}
        </span>
        <button
          onClick={() => onCancel(orders.map((o) => o.orderID))}
          disabled={busy}
          className="rounded border border-line px-2 py-0.5 text-[10px] text-fg-muted transition-colors hover:border-negative/40 hover:text-negative disabled:opacity-50"
        >
          {busy ? "Cancelling…" : "Cancel all"}
        </button>
      </div>
      <div
        className="grid gap-2 border-b border-line px-4 py-1 text-[9px] uppercase tracking-wider text-fg-dim"
        style={{ gridTemplateColumns: OO_COLS }}
      >
        <span>Side</span>
        <span className="text-right">Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Filled</span>
        <span className="text-right">Time</span>
        <span />
      </div>
      {orders.map((o) => {
        const buy = o.side === SodexSide.BUY;
        const isLimit = o.type === SodexOrderType.LIMIT;
        return (
          <div
            key={o.orderID}
            className="grid items-center gap-2 px-4 py-1.5 font-[var(--font-jetbrains-mono)] tabular-nums hover:bg-surface-2/40"
            style={{ gridTemplateColumns: OO_COLS }}
          >
            <span className={buy ? "text-positive" : "text-negative"}>
              {buy ? "Buy" : "Sell"}
              <span className="ml-1 text-[9px] text-fg-dim">{isLimit ? "LMT" : "MKT"}</span>
            </span>
            <span className="text-right">{px(o.price)}</span>
            <span className="text-right">{o.origQty ? qtyFmt(Number(o.origQty)) : "—"}</span>
            <span className="text-right text-fg-muted">
              {o.executedQty ? qtyFmt(Number(o.executedQty)) : "0"}
            </span>
            <span className="text-right text-fg-dim">
              {o.createdAt ? fmtTime(o.createdAt) : "—"}
            </span>
            <span className="text-right">
              <button
                onClick={() => onCancel([o.orderID])}
                disabled={busy}
                className="rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-muted transition-colors hover:border-negative/40 hover:text-negative disabled:opacity-50"
              >
                Cancel
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
