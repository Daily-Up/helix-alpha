"use client";

/**
 * BottomPanel — the terminal's Positions / Open Orders / Trade History /
 * Funding / Order History tabs, wired to the live perps account state
 * (fetched in the parent). A toolbar on the right of the tab bar filters to
 * the current market and closes every position. Disconnected or empty tabs
 * show a short empty state with a Connect SoDEX CTA.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { AssetLogo } from "@/components/ui/AssetLogo";
import { TpSlModal, type TpSlMeta } from "./TpSlModal";
import {
  SodexSide,
  SodexOrderType,
  type SodexPerpsAccountState,
  type SodexOpenOrder,
  type SodexFundingPayment,
  type SodexTrade,
  type SodexOrderHistory,
  type SodexClosedPosition,
} from "@/lib/sodex-onchain/types";
import {
  getAccountTrades,
  getOrderHistory,
  getPositionsHistory,
} from "@/lib/sodex-onchain/client";

export const BOTTOM_TABS = [
  "Positions",
  "Open Orders",
  "Trade History",
  "Order History",
  "Closed Positions",
  "Funding",
] as const;
export type BottomTab = (typeof BOTTOM_TABS)[number];

// Plain positive $ (notional, margin, value, fees) — no sign, 2 decimals by
// default; a non-zero magnitude under a cent collapses to "<$0.01". Pass d=4
// for sub-cent fee ESTIMATES (order ticket / confirm) that want more precision.
const money = (v: number | null | undefined, d = 2) => {
  if (v == null || !Number.isFinite(v)) return "—";
  if (d <= 2 && v > 0 && v < 0.01) return "<$0.01";
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
};
// Decimals a symbol's tick size implies (0.0001 → 4, 0.1 → 1, 1 → 0).
const decimalsFromTick = (tick?: number) => {
  if (!tick || !Number.isFinite(tick) || tick <= 0) return 2;
  if (tick >= 1) return 0;
  return Math.min(8, Math.ceil(-Math.log10(tick)));
};
// A price at its symbol's tick precision, with trailing zeros (and a dangling
// decimal point) trimmed: 71,000.0000 → 71,000; 1,080.6200 → 1,080.62.
const fmtPrice = (value: number | null | undefined, tick?: number) => {
  if (value == null || !Number.isFinite(value)) return "—";
  let s = value.toLocaleString(undefined, {
    minimumFractionDigits: decimalsFromTick(tick),
    maximumFractionDigits: decimalsFromTick(tick),
  });
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
};
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
// Short "time until next funding" from ms remaining (e.g. "1h 23m", "4m 09s").
const fmtCountdown = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${two(ss)}s` : `${ss}s`;
};
// Signed est. funding for a position at the current rate: a long PAYS (negative)
// when the rate is positive and a short RECEIVES (positive); reversed when the
// rate is negative. notional = |size| × mark; rate = raw fraction per interval.
const fundingEst = (notional: number, isLong: boolean, rate: number) =>
  (isLong ? -1 : 1) * notional * rate;
// Funding is a signed dollar amount: 2 decimals, sub-cent → "±<$0.01".
const fundingFmt = (v: number) => signedMoney(v);
// next funding time may arrive in seconds or ms; normalise to ms.
const nextFundingMs = (next: number) =>
  next > 0 ? (next < 1e12 ? next * 1000 : next) : 0;
// Compact local date + time for a funding settlement, e.g. "Nov 2, 21:00".
const fmtDateTime = (t: number) =>
  new Date(t < 1e12 ? t * 1000 : t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
// Display names use the -PERP convention everywhere, matching the header.
const perpName = (s: string) => s.replace(/-USDC?$/i, "-PERP");
const baseOf = (s: string) => s.split("-")[0] || s;
const marginModeLabel = (m?: string) =>
  m ? m.charAt(0).toUpperCase() + m.slice(1).toLowerCase() : null;

// Read endpoints return "BUY"/"SELL"/"MARKET"/"LIMIT"/"NEW" as STRINGS; the
// place path uses the numeric enums. These helpers accept either.
const sideIsBuy = (s: unknown) =>
  s === "BUY" || s === "Buy" || s === SodexSide.BUY;
const sideLabel = (s: unknown) => (sideIsBuy(s) ? "Buy" : "Sell");
/** A row's display order type + whether it's a trigger (stop) order. */
function orderTypeInfo(o: { type?: unknown; stopType?: string }): {
  label: string;
  isStop: boolean;
} {
  const st = (o.stopType ?? "").toString().toUpperCase();
  if (st === "TAKE_PROFIT") return { label: "TP · Stop Market", isStop: true };
  if (st === "STOP_LOSS") return { label: "SL · Stop Market", isStop: true };
  const t = o.type;
  if (t === "LIMIT" || t === SodexOrderType.LIMIT)
    return { label: "Limit", isStop: false };
  if (t === "MARKET" || t === SodexOrderType.MARKET)
    return { label: "Market", isStop: false };
  return { label: t != null ? String(t) : "—", isStop: false };
}
// Filled qty shown with the same decimals as the order size ("0" → "0.00000").
const qtyDecimals = (s?: string) => {
  const d = (s ?? "").split(".")[1];
  return d ? d.length : 0;
};
const filledFmt = (filled?: string, size?: string) => {
  const n = Number(filled ?? 0);
  return Number.isFinite(n) ? n.toFixed(qtyDecimals(size)) : "0";
};
// Does a symbol pass the "Current market only" filter?
const symbolMatches = (
  sym: string,
  currentOnly: boolean,
  selectedSymbol: string | null,
) => {
  if (!currentOnly) return true;
  const sel = (selectedSymbol ?? "").toUpperCase();
  return sym.toUpperCase() === sel || baseOf(sym).toUpperCase() === baseOf(sel);
};
/** Status → tone for history rows. */
const statusTone = (status: string) => {
  const s = status.toUpperCase();
  if (s === "FILLED" || s === "TRIGGERED") return "text-positive";
  if (s === "CANCELED" || s === "CANCELLED" || s === "EXPIRED") return "text-fg-muted";
  if (s === "REJECTED") return "text-negative";
  return "text-fg";
};
const titleCase = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;

type Position = NonNullable<SodexPerpsAccountState["P"]>[number];

/** Per-symbol funding snapshot: raw rate (fraction per interval) + next
 *  funding time in ms. */
export type FundingInfo = { rate: number; next: number };

export type TpSlCtx = {
  /** Per-symbol metadata keyed by sodex symbol (so TP/SL works for any market). */
  meta: Record<string, TpSlMeta>;
  /** Live mark price per symbol. */
  markBySymbol: Record<string, number>;
  builderRate: number;
  busy: boolean;
  /** Placement is disabled until the SoDEX trigger payload fix is approved. */
  placementEnabled: boolean;
  /** Place/modify/cancel TP & SL per leg (number places, "cancel" cancels the
   *  resting trigger, null leaves it). Place-new-then-cancel-old on a modify. */
  onSet: (
    pos: Position,
    next: { tp: number | "cancel" | null; sl: number | "cancel" | null },
    existing: { tpOrderId: number | null; slOrderId: number | null },
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Cancel one resting trigger directly (positions table ×); verifies + toasts. */
  onRemove: (pos: Position, orderID: number) => Promise<{ ok: boolean; error?: string }>;
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
  tickBySymbol,
  fundingBySymbol,
  fundingInterval,
  accountFundings,
  now,
  selectedSymbol,
  tpsl,
  ready,
  digits,
  address,
  historyRefreshKey,
}: {
  tab: BottomTab;
  setTab: (t: BottomTab) => void;
  account: SodexPerpsAccountState | null;
  openOrders: SodexOpenOrder[];
  onCancel: (orders: SodexOpenOrder[]) => void;
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
  /** Price tick size keyed by sodex symbol — each row prices to its OWN tick. */
  tickBySymbol: Record<string, number>;
  /** Per-symbol funding: raw rate (fraction/interval) + next funding time (ms). */
  fundingBySymbol: Record<string, FundingInfo>;
  /** Funding interval in seconds, for the annualized rate. */
  fundingInterval: number;
  /** Realized funding payments for the account (Funding tab, most-recent first). */
  accountFundings: SodexFundingPayment[];
  /** Date.now() ms, ticking each second — for the funding countdown. */
  now: number;
  /** Currently-selected market symbol, for the "Current market only" filter. */
  selectedSymbol: string | null;
  /** TP/SL placement context (selected market rules + the place/modify call). */
  tpsl: TpSlCtx;
  ready: boolean;
  digits: number;
  /** Master account address (0x…) for the history tabs' own fetches. */
  address: string | null;
  /** Bumps after any order action so open history tabs refetch. */
  historyRefreshKey: number;
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
    "Order History": 0,
    "Closed Positions": 0,
    Funding: 0,
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
          {/* Close All belongs to Positions only; Open Orders has its own
              "Cancel all" inside the list. */}
          {tab === "Positions" ? (
            <button
              onClick={() => setCloseAllOpen(true)}
              disabled={allPositions.length === 0 || closeAllBusy}
              className="rounded border border-negative/50 px-2 py-0.5 text-[11px] font-medium text-negative transition-colors hover:bg-negative/10 disabled:opacity-40"
            >
              {closeAllBusy ? "Closing…" : "Close All"}
            </button>
          ) : null}
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
              markBySymbol={markBySymbol}
              tickBySymbol={tickBySymbol}
              fundingBySymbol={fundingBySymbol}
              now={now}
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
            <OpenOrders
              orders={orders}
              onCancel={onCancel}
              busy={cancelBusy}
              tickBySymbol={tickBySymbol}
              currentOnly={currentOnly}
              selectedSymbol={selectedSymbol}
            />
          )
        ) : tab === "Trade History" ? (
          <TradeHistoryView
            address={address}
            currentOnly={currentOnly}
            selectedSymbol={selectedSymbol}
            refreshKey={historyRefreshKey}
            tickBySymbol={tickBySymbol}
          />
        ) : tab === "Order History" ? (
          <OrderHistoryView
            address={address}
            currentOnly={currentOnly}
            selectedSymbol={selectedSymbol}
            refreshKey={historyRefreshKey}
            tickBySymbol={tickBySymbol}
          />
        ) : tab === "Closed Positions" ? (
          <ClosedPositionsView
            address={address}
            currentOnly={currentOnly}
            selectedSymbol={selectedSymbol}
            refreshKey={historyRefreshKey}
            tickBySymbol={tickBySymbol}
          />
        ) : (
          <FundingView
            positions={positions}
            markBySymbol={markBySymbol}
            fundingBySymbol={fundingBySymbol}
            fundingInterval={fundingInterval}
            fundings={accountFundings}
            now={now}
          />
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
// Columns distribute by fr and compress to the panel width (only Market keeps
// a small floor), so the table never forces a horizontal scroll — it fits the
// chart+book width at 1366 and breathes at 1920. (Funding dropped: SoDEX
// exposes no per-position funding, so it was always "—".)
const POS_COLS =
  "minmax(96px,1.7fr) minmax(0,1.05fr) minmax(0,0.95fr) minmax(0,0.95fr) minmax(0,0.95fr) minmax(0,1.35fr) minmax(0,1fr) minmax(0,0.82fr) minmax(0,1fr) minmax(0,0.95fr) minmax(0,0.95fr) minmax(0,0.78fr)";

/** Read a (possibly runtime-only) stopPrice off an open order. */
function stopPriceOf(o: SodexOpenOrder): number | null {
  const sp = (o as { stopPrice?: string }).stopPrice;
  const n = sp != null ? Number(sp) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Resting TP / SL triggers for a position, from its reduce-only stop orders.
 *  Classifies by trigger vs entry: above entry on a long = TP, below = SL. */
function tpslFor(pos: Position, orders: SodexOpenOrder[]) {
  const entry = Number(pos.ep);
  const isLong = Number(pos.sz) >= 0;
  const stops = orders.filter(
    (o) =>
      o.symbol.toUpperCase() === pos.s.toUpperCase() &&
      o.reduceOnly &&
      stopPriceOf(o) != null,
  );
  const tpOrder =
    stops.find((o) => {
      const t = stopPriceOf(o) as number;
      return isLong ? t > entry : t < entry;
    }) ?? null;
  const slOrder =
    stops.find((o) => {
      const t = stopPriceOf(o) as number;
      return isLong ? t < entry : t > entry;
    }) ?? null;
  return {
    tp: tpOrder ? stopPriceOf(tpOrder) : null,
    sl: slOrder ? stopPriceOf(slOrder) : null,
    tpOrderId: tpOrder?.orderID ?? null,
    slOrderId: slOrder?.orderID ?? null,
  };
}

function PositionsView({
  positions,
  orders,
  markBySymbol,
  tickBySymbol,
  fundingBySymbol,
  now,
  selectedSymbol,
  tpsl,
  onSelect,
  onClose,
}: {
  positions: Position[];
  orders: SodexOpenOrder[];
  markBySymbol: Record<string, number>;
  tickBySymbol: Record<string, number>;
  fundingBySymbol: Record<string, FundingInfo>;
  now: number;
  selectedSymbol: string | null;
  tpsl: TpSlCtx;
  onSelect: (sodexSymbol: string) => void;
  onClose: (position: Position, type: "market" | "limit") => void;
}) {
  // Open ⋯ menu + TP/SL modal state.
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const [modal, setModal] = useState<{ pos: Position; focus: "tp" | "sl" } | null>(null);
  const openModal = (pos: Position, focus: "tp" | "sl") => setModal({ pos, focus });
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
    "SL",
    "TP",
    "",
  ];
  return (
    <div className="min-w-0 text-[11.5px]">
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

        // Resting TP / SL triggers for this position.
        const { tp, sl, tpOrderId, slOrderId } = tpslFor(p, orders);
        // Prices use THIS row's symbol tick (not the selected market's).
        const tick = tickBySymbol[p.s.toUpperCase()];
        const pxRow = (v: number) => fmtPrice(v, tick);

        // Funding: total ACCRUED on this open position so far (p.ff), plus the
        // current rate / est. next / countdown for the cell's hover.
        const f = fundingBySymbol[p.s.toUpperCase()];
        const accruedFunding = p.ff != null ? Number(p.ff) : null;
        const estNextFunding =
          f && value != null ? fundingEst(value, isLong, f.rate) : null;
        const fundingRatePct = f ? f.rate * 100 : null;
        const fundingNextMs = f ? nextFundingMs(f.next) : 0;
        const fundingCd =
          fundingNextMs > 0 ? fmtCountdown(fundingNextMs - now) : null;

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
            <span className="text-right text-fg-muted">{pxRow(entry)}</span>
            {/* Mark */}
            <span className="text-right">{mark != null ? pxRow(mark) : "—"}</span>
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
              {liq != null ? pxRow(liq) : "—"}
            </span>
            {/* Margin */}
            <span className="text-right text-fg-muted">
              {margin != null ? money(margin) : "—"}
            </span>
            {/* Funding — total funding ACCRUED on this position so far (p.ff),
                signed (green = received, red = paid). Rate / est. next / count-
                down on hover. */}
            <FundingCell
              accrued={accruedFunding}
              estNext={estNextFunding}
              ratePct={fundingRatePct}
              cd={fundingCd}
            />
            {/* SL */}
            <TriggerCell
              value={sl}
              tone="neg"
              label="SL"
              px={pxRow}
              orderId={slOrderId}
              onEdit={() => openModal(p, "sl")}
              onCancel={(id) => tpsl.onRemove(p, id)}
            />
            {/* TP */}
            <TriggerCell
              value={tp}
              tone="pos"
              label="TP"
              px={pxRow}
              orderId={tpOrderId}
              onEdit={() => openModal(p, "tp")}
              onCancel={(id) => tpsl.onRemove(p, id)}
            />
            {/* Close (×) + ⋯ menu (Set TP/SL · Limit close) */}
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
                  <div className="absolute right-0 top-full z-40 mt-1 w-32 overflow-hidden rounded-md border border-line bg-surface shadow-xl">
                    <button
                      onClick={() => {
                        openModal(p, "tp");
                        setMenuRow(null);
                      }}
                      className="block w-full px-3 py-1.5 text-left text-[11px] text-fg-muted hover:bg-surface-2 hover:text-fg"
                    >
                      Set TP/SL
                    </button>
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
      {modal ? (
        <TpSlModal
          position={modal.pos}
          meta={tpsl.meta[(modal.pos.s ?? "").toUpperCase()] ?? null}
          mark={tpsl.markBySymbol[(modal.pos.s ?? "").toUpperCase()] ?? null}
          builderRate={tpsl.builderRate}
          existing={tpslFor(modal.pos, orders)}
          focus={modal.focus}
          placementEnabled={tpsl.placementEnabled}
          busy={tpsl.busy}
          onSet={tpsl.onSet}
          onClose={() => setModal(null)}
        />
      ) : null}
    </div>
  );
}

/** One SL or TP cell: the trigger price (or "-"), a × that cancels it directly
 *  (one-line Yes/No popover, verified), and a pencil that opens the modal. */
function TriggerCell({
  value,
  tone,
  label,
  px,
  orderId,
  onEdit,
  onCancel,
}: {
  value: number | null;
  tone: "pos" | "neg";
  label: "SL" | "TP";
  px: (v: number) => string;
  orderId: number | null;
  onEdit: () => void;
  onCancel: (orderID: number) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const canCancel = value != null && orderId != null;
  return (
    <span className="relative flex items-center justify-end gap-1 text-right">
      <span className={cn("tabular-nums", tone === "pos" ? "text-positive" : "text-negative")}>
        {value != null ? px(value) : "-"}
      </span>
      {canCancel ? (
        <button
          onClick={() => setConfirm(true)}
          title={`Cancel ${label}`}
          className="rounded border border-transparent px-0.5 text-[12px] leading-4 text-negative transition-colors hover:border-negative/50"
        >
          ×
        </button>
      ) : null}
      <button
        onClick={onEdit}
        title="Set TP / SL"
        className="rounded border border-line px-1 text-[10px] text-fg-dim transition-colors hover:text-fg"
      >
        ✎
      </button>
      {confirm && canCancel ? (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setConfirm(false)} />
          <div className="absolute right-0 top-full z-40 mt-1 flex items-center gap-2 whitespace-nowrap rounded-md border border-line bg-surface px-2.5 py-1.5 text-[11px] shadow-xl">
            <span className="text-fg-muted">
              Cancel {label} {px(value as number)}?
            </span>
            <button
              onClick={() => {
                setConfirm(false);
                onCancel(orderId as number);
              }}
              className="rounded bg-negative/15 px-1.5 py-0.5 font-medium text-negative transition-colors hover:bg-negative/25"
            >
              Yes
            </button>
            <button
              onClick={() => setConfirm(false)}
              className="rounded px-1.5 py-0.5 text-fg-dim transition-colors hover:text-fg"
            >
              No
            </button>
          </div>
        </>
      ) : null}
    </span>
  );
}

/** Positions "Funding" cell — total funding ACCRUED on the open position so
 *  far (p.ff), signed (green = received, red = paid). The current rate, est.
 *  next payment and countdown to the next settlement are on hover. */
function FundingCell({
  accrued,
  estNext,
  ratePct,
  cd,
}: {
  accrued: number | null;
  estNext: number | null;
  ratePct: number | null;
  cd: string | null;
}) {
  if (accrued == null || !Number.isFinite(accrued)) {
    return (
      <span className="text-right text-fg-dim" title="Funding not available yet">
        —
      </span>
    );
  }
  const title =
    `Funding accrued on this position ${fundingFmt(accrued)}` +
    (estNext != null ? ` · est. next ${fundingFmt(estNext)}` : "") +
    (ratePct != null
      ? ` (rate ${ratePct >= 0 ? "+" : ""}${ratePct.toFixed(4)}%/interval${cd ? `, in ${cd}` : ""})`
      : "");
  return (
    <span
      className={cn(
        "text-right",
        accrued > 0 ? "text-positive" : accrued < 0 ? "text-negative" : "text-fg-muted",
      )}
      title={title}
    >
      {fundingFmt(accrued)}
    </span>
  );
}

const FUND_COLS =
  "minmax(96px,1.4fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.1fr) minmax(0,0.9fr)";
const FHIST_COLS =
  "minmax(104px,1.2fr) minmax(72px,1fr) minmax(0,0.7fr) minmax(0,1fr)";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-line bg-surface-2/30 px-4 py-1 text-[9px] font-medium uppercase tracking-wider text-fg-dim">
      {children}
    </div>
  );
}

/** Funding tab — "Upcoming" per-position forward estimate (rate, annualized,
 *  est. next, countdown) over realized funding history pulled from the account
 *  (/accounts/{addr}/fundings), with a net total. */
function FundingView({
  positions,
  markBySymbol,
  fundingBySymbol,
  fundingInterval,
  fundings,
  now,
}: {
  positions: Position[];
  markBySymbol: Record<string, number>;
  fundingBySymbol: Record<string, FundingInfo>;
  fundingInterval: number;
  fundings: SodexFundingPayment[];
  now: number;
}) {
  const periodsPerYear =
    (365 * 24 * 3600) / (fundingInterval > 0 ? fundingInterval : 3600);
  const net = fundings.reduce((s, f) => s + (Number(f.fundingFee) || 0), 0);
  const hasPositions = positions.length > 0;
  const hasHistory = fundings.length > 0;
  if (!hasPositions && !hasHistory) {
    return <Empty>No funding yet — open a position to start accruing funding.</Empty>;
  }
  return (
    <div className="text-[11.5px]">
      {/* ── Upcoming (estimated) — only while holding positions ── */}
      {hasPositions ? (
        <>
          <SectionLabel>Upcoming · estimated next funding</SectionLabel>
          <div
            className="grid gap-2 border-b border-line px-4 py-1.5 text-[9px] uppercase tracking-wider text-fg-dim"
            style={{ gridTemplateColumns: FUND_COLS }}
          >
            <span>Market</span>
            <span className="text-right">Funding Rate</span>
            <span className="text-right">Annualized</span>
            <span className="text-right">Est. Next Funding</span>
            <span className="text-right">Next In</span>
          </div>
          {positions.map((p) => {
            const sz = Number(p.sz);
            const isLong = sz >= 0;
            const abs = Math.abs(sz);
            const mark = markBySymbol[p.s.toUpperCase()] ?? Number(p.ep);
            const notional = abs * mark;
            const f = fundingBySymbol[p.s.toUpperCase()];
            const ratePct = f ? f.rate * 100 : null;
            const annual = ratePct != null ? ratePct * periodsPerYear : null;
            const est = f ? fundingEst(notional, isLong, f.rate) : null;
            const nextMs = f ? nextFundingMs(f.next) : 0;
            const cd = nextMs > 0 ? fmtCountdown(nextMs - now) : "—";
            return (
              <div
                key={`${p.i}-${p.s}`}
                className="grid items-center gap-2 px-4 py-1.5 font-[var(--font-jetbrains-mono)] tabular-nums hover:bg-surface-2/40"
                style={{ gridTemplateColumns: FUND_COLS }}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <AssetLogo symbol={p.s} size={16} />
                  <span className="truncate text-fg">{perpName(p.s)}</span>
                  <span
                    className={cn(
                      "rounded px-1 text-[8.5px] font-semibold uppercase",
                      isLong ? "bg-positive/15 text-positive" : "bg-negative/15 text-negative",
                    )}
                  >
                    {isLong ? "Long" : "Short"}
                  </span>
                </span>
                <span
                  className={cn(
                    "text-right",
                    ratePct == null ? "text-fg-dim" : ratePct >= 0 ? "text-positive" : "text-negative",
                  )}
                >
                  {ratePct == null ? "—" : `${ratePct >= 0 ? "+" : ""}${ratePct.toFixed(4)}%`}
                </span>
                <span
                  className={cn(
                    "text-right",
                    annual == null ? "text-fg-dim" : annual >= 0 ? "text-positive" : "text-negative",
                  )}
                >
                  {annual == null ? "—" : `${annual >= 0 ? "+" : ""}${annual.toFixed(2)}%`}
                </span>
                <span
                  className={cn(
                    "text-right",
                    est == null
                      ? "text-fg-dim"
                      : est > 0
                        ? "text-positive"
                        : est < 0
                          ? "text-negative"
                          : "text-fg-muted",
                  )}
                >
                  {est == null ? "—" : fundingFmt(est)}
                </span>
                <span className="text-right text-fg-dim">{cd}</span>
              </div>
            );
          })}
        </>
      ) : null}

      {/* ── Realized funding history (from /accounts/{addr}/fundings) ── */}
      <div className="flex items-center justify-between border-b border-t border-line bg-surface-2/30 px-4 py-1">
        <span className="text-[9px] font-medium uppercase tracking-wider text-fg-dim">
          History{hasHistory ? ` · last ${fundings.length}` : ""}
        </span>
        {hasHistory ? (
          <span className="text-[10px] text-fg-dim">
            Net{" "}
            <span
              className={cn(
                "font-[var(--font-jetbrains-mono)] tabular-nums",
                net >= 0 ? "text-positive" : "text-negative",
              )}
            >
              {fundingFmt(net)}
            </span>
          </span>
        ) : null}
      </div>
      {hasHistory ? (
        <>
          <div
            className="grid gap-2 border-b border-line px-4 py-1 text-[9px] uppercase tracking-wider text-fg-dim"
            style={{ gridTemplateColumns: FHIST_COLS }}
          >
            <span>Time</span>
            <span>Market</span>
            <span>Side</span>
            <span className="text-right">Payment</span>
          </div>
          {fundings.map((f, i) => {
            const amt = Number(f.fundingFee) || 0;
            const isLong = (f.positionSide ?? "").toUpperCase() === "LONG";
            return (
              <div
                key={`${f.positionID}-${f.timestamp}-${i}`}
                className="grid items-center gap-2 px-4 py-1.5 font-[var(--font-jetbrains-mono)] tabular-nums hover:bg-surface-2/40"
                style={{ gridTemplateColumns: FHIST_COLS }}
              >
                <span className="text-fg-dim">{fmtDateTime(f.timestamp)}</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <AssetLogo symbol={f.symbol} size={15} />
                  <span className="truncate text-fg">{baseOf(f.symbol)}</span>
                </span>
                <span className={isLong ? "text-positive" : "text-negative"}>
                  {isLong ? "Long" : "Short"}
                </span>
                <span
                  className={cn(
                    "text-right",
                    amt > 0 ? "text-positive" : amt < 0 ? "text-negative" : "text-fg-muted",
                  )}
                >
                  {fundingFmt(amt)}
                </span>
              </div>
            );
          })}
        </>
      ) : (
        <p className="px-4 py-3 text-[11px] text-fg-dim">
          No funding payments yet — they appear here each time funding settles.
        </p>
      )}
    </div>
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

/** Confirm dialog for "Cancel all" — lists every order the click will cancel,
 *  scoped exactly to what the list is showing (current market, or all). */
function CancelAllConfirm({
  orders,
  tickBySymbol,
  busy,
  scopeLabel,
  onConfirm,
  onClose,
}: {
  orders: SodexOpenOrder[];
  tickBySymbol: Record<string, number>;
  busy: boolean;
  scopeLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const px = (v: string | number | undefined, sym: string) =>
    v != null && Number.isFinite(Number(v))
      ? fmtPrice(Number(v), tickBySymbol[(sym ?? "").toUpperCase()])
      : "—";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const n = orders.length;
  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-lg border border-negative/40 bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-4 py-2.5 text-[13px] font-semibold text-fg">
          Cancel {n} order{n === 1 ? "" : "s"} · {scopeLabel}
        </div>
        <div className="max-h-[240px] overflow-y-auto px-4 py-2">
          {orders.map((o) => {
            const buy = sideIsBuy(o.side);
            const { label: typeLabel, isStop } = orderTypeInfo(o);
            const trig = isStop && Number(o.stopPrice) > 0 ? Number(o.stopPrice) : null;
            return (
              <div
                key={o.orderID}
                className="flex items-center justify-between py-1 font-[var(--font-jetbrains-mono)] text-[11.5px] tabular-nums"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="text-fg">{perpName(o.symbol)}</span>
                  <span className={buy ? "text-positive" : "text-negative"}>
                    {buy ? "Buy" : "Sell"}
                  </span>
                  <span className="truncate text-[9px] text-fg-dim">{typeLabel}</span>
                </span>
                <span className="text-fg-muted">
                  {o.origQty ? qtyFmt(Number(o.origQty)) : "—"}
                  {trig != null
                    ? ` @ ${px(trig, o.symbol)} trig`
                    : Number(o.price) > 0
                      ? ` @ ${px(o.price, o.symbol)}`
                      : ""}
                </span>
              </div>
            );
          })}
        </div>
        <p className="px-4 pb-2 pt-1 text-[10px] text-fg-dim">
          Sends a signed cancel for each order above. Real orders on SoDEX mainnet.
        </p>
        <div className="flex gap-2 border-t border-line px-4 py-3">
          <button
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 rounded border border-negative/60 bg-negative/15 py-2 text-[13px] font-semibold text-negative transition-colors hover:bg-negative/25 disabled:opacity-60"
          >
            {busy ? "Cancelling…" : `Cancel ${n} order${n === 1 ? "" : "s"}`}
          </button>
          <button
            onClick={onClose}
            disabled={busy}
            className="flex-1 rounded border border-line py-2 text-[13px] text-fg-muted hover:text-fg"
          >
            Keep orders
          </button>
        </div>
      </div>
    </div>
  );
}

// Time | Market | Type | Side | Price | Trigger | Size | Filled | Cancel
const OO_COLS =
  "minmax(78px,0.95fr) minmax(74px,1fr) minmax(92px,1.3fr) 42px minmax(0,0.95fr) minmax(0,0.95fr) minmax(0,0.95fr) minmax(0,0.9fr) 50px";

function OpenOrders({
  orders,
  onCancel,
  busy,
  tickBySymbol,
  currentOnly,
  selectedSymbol,
}: {
  orders: SodexOpenOrder[];
  onCancel: (orders: SodexOpenOrder[]) => void;
  busy: boolean;
  tickBySymbol: Record<string, number>;
  /** Whether the panel's "Current market only" filter is on. */
  currentOnly: boolean;
  selectedSymbol: string | null;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Header + cancel-all scope must agree: "N open · BTC-PERP" when the current-
  // market filter is on or all orders share one market, else "N open · all
  // markets".
  const markets = new Set(orders.map((o) => baseOf(o.symbol).toUpperCase()));
  const scope = currentOnly
    ? perpName(selectedSymbol ?? "")
    : markets.size <= 1
      ? perpName(orders[0]?.symbol ?? "")
      : "all markets";
  return (
    <div className="text-[11.5px]">
      <div className="flex items-center justify-between border-b border-line px-4 py-1.5">
        <span className="text-[9px] uppercase tracking-wider text-fg-dim">
          {orders.length} open · {scope}
        </span>
        <button
          onClick={() => setConfirmOpen(true)}
          disabled={busy || orders.length === 0}
          className="rounded border border-line px-2 py-0.5 text-[10px] text-fg-muted transition-colors hover:border-negative/40 hover:text-negative disabled:opacity-50"
        >
          {busy ? "Cancelling…" : `Cancel all (${scope})`}
        </button>
      </div>
      {confirmOpen ? (
        <CancelAllConfirm
          orders={orders}
          tickBySymbol={tickBySymbol}
          busy={busy}
          scopeLabel={scope}
          onConfirm={() => {
            onCancel(orders);
            setConfirmOpen(false);
          }}
          onClose={() => setConfirmOpen(false)}
        />
      ) : null}
      <div
        className="grid gap-2 border-b border-line px-4 py-1 text-[9px] uppercase tracking-wider text-fg-dim"
        style={{ gridTemplateColumns: OO_COLS }}
      >
        <span>Time</span>
        <span>Market</span>
        <span>Type</span>
        <span>Side</span>
        <span className="text-right">Price</span>
        <span className="text-right">Trigger</span>
        <span className="text-right">Size</span>
        <span className="text-right">Filled</span>
        <span />
      </div>
      {orders.map((o) => {
        const buy = sideIsBuy(o.side);
        const { label: typeLabel, isStop } = orderTypeInfo(o);
        const tick = tickBySymbol[o.symbol.toUpperCase()];
        return (
          <div
            key={o.orderID}
            className="grid items-center gap-2 px-4 py-1.5 font-[var(--font-jetbrains-mono)] tabular-nums hover:bg-surface-2/40"
            style={{ gridTemplateColumns: OO_COLS }}
          >
            <span className="text-fg-dim">{o.createdAt ? fmtDateTime(o.createdAt) : "—"}</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <AssetLogo symbol={o.symbol} size={15} />
              <span className="truncate text-fg">{perpName(o.symbol)}</span>
            </span>
            <span className="flex min-w-0 items-center gap-1 truncate">
              <span className={cn("truncate", isStop ? "text-fg" : "text-fg-muted")}>
                {typeLabel}
              </span>
              {o.reduceOnly ? (
                <span className="shrink-0 rounded bg-surface-2 px-1 text-[8px] uppercase tracking-wide text-fg-dim">
                  RO
                </span>
              ) : null}
            </span>
            <span className={buy ? "text-positive" : "text-negative"}>
              {buy ? "Buy" : "Sell"}
            </span>
            {/* Price: limit → limit price; market / stop-market → "Market". */}
            <span className="text-right text-fg-muted">
              {Number(o.price) > 0 ? fmtPrice(Number(o.price), tick) : "Market"}
            </span>
            {/* Trigger: stop orders show the trigger price, never a bare "—". */}
            <span className={cn("text-right", isStop ? "text-[#e0a53f]" : "text-fg-dim")}>
              {isStop && Number(o.stopPrice) > 0 ? fmtPrice(Number(o.stopPrice), tick) : "—"}
            </span>
            <span className="text-right">{o.origQty ? qtyFmt(Number(o.origQty)) : "—"}</span>
            <span className="text-right text-fg-muted">
              {filledFmt(o.executedQty, o.origQty)}
            </span>
            <span className="text-right">
              <button
                onClick={() => onCancel([o])}
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

// ─────────────────────────── History tabs ───────────────────────────
// Prices in history span markets, so size the precision to the value (the
// selected market's `digits` is only a hint).
type FetchState = "loading" | "error" | "ready";

/** Loading / error states for a history list (empty is the caller's to render,
 *  so an empty list and an API error look different). */
function HistoryStatus({ state, err }: { state: FetchState; err: string | null }) {
  if (state === "error")
    return (
      <div className="flex flex-col items-center gap-1 px-4 py-8 text-center text-[12px]">
        <span className="text-negative">Couldn’t load from SoDEX.</span>
        {err ? <span className="text-[11px] text-fg-dim">{err}</span> : null}
      </div>
    );
  return (
    <div className="px-4 py-8 text-center text-[12px] text-fg-dim">Loading…</div>
  );
}

/** Fetch a history list for the account, refetching on refreshKey / address.
 *  Keeps the prior rows visible across a silent refresh. */
function useAccountHistory<T>(
  address: string | null,
  refreshKey: number,
  load: (addr: `0x${string}`) => Promise<T[]>,
): { rows: T[]; state: FetchState; err: string | null } {
  const [rows, setRows] = useState<T[]>([]);
  const [state, setState] = useState<FetchState>("loading");
  const [err, setErr] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const hasRows = useRef(false);
  useEffect(() => {
    if (!address) {
      setRows([]);
      hasRows.current = false;
      setState("ready");
      return;
    }
    let cancelled = false;
    if (!hasRows.current) setState("loading");
    loadRef
      .current(address as `0x${string}`)
      .then((data) => {
        if (cancelled) return;
        hasRows.current = data.length > 0;
        setRows(data);
        setErr(null);
        setState("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        setErr((e as Error).message || "request failed");
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [address, refreshKey]);
  return { rows, state, err };
}

type HistoryViewProps = {
  address: string | null;
  currentOnly: boolean;
  selectedSymbol: string | null;
  refreshKey: number;
  tickBySymbol: Record<string, number>;
};

const TH_COLS =
  "minmax(92px,1fr) minmax(74px,0.95fr) 42px minmax(0,0.95fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.85fr) minmax(0,0.9fr) 52px";

/** Trade History — fills, newest first, paged on scroll (limit + endTime). */
function TradeHistoryView({
  address,
  currentOnly,
  selectedSymbol,
  refreshKey,
  tickBySymbol,
}: HistoryViewProps) {
  const PAGE = 100;
  const [rows, setRows] = useState<SodexTrade[]>([]);
  const [state, setState] = useState<FetchState>("loading");
  const [err, setErr] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [done, setDone] = useState(false);
  const hasRows = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!address) {
      setRows([]);
      hasRows.current = false;
      setState("ready");
      return;
    }
    let cancelled = false;
    if (!hasRows.current) setState("loading");
    setDone(false);
    getAccountTrades("mainnet", address as `0x${string}`, { limit: PAGE })
      .then((data) => {
        if (cancelled) return;
        hasRows.current = data.length > 0;
        setRows(data);
        setDone(data.length < PAGE);
        setErr(null);
        setState("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        setErr((e as Error).message || "request failed");
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [address, refreshKey]);

  const loadMore = useCallback(async () => {
    if (!address || loadingMore || done || rows.length === 0) return;
    setLoadingMore(true);
    try {
      const oldest = rows[rows.length - 1];
      const older = await getAccountTrades("mainnet", address as `0x${string}`, {
        limit: PAGE,
        endTime: oldest.time - 1,
      });
      setRows((prev) => [...prev, ...older]);
      if (older.length < PAGE) setDone(true);
    } catch {
      /* keep what we have */
    } finally {
      setLoadingMore(false);
    }
  }, [address, loadingMore, done, rows]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => es[0]?.isIntersecting && loadMore(),
      { rootMargin: "160px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  const shown = rows.filter((t) =>
    symbolMatches(t.symbol, currentOnly, selectedSymbol),
  );
  if (state !== "ready") return <HistoryStatus state={state} err={err} />;
  if (shown.length === 0) return <Empty>No trades in this range.</Empty>;
  const totalFee = shown.reduce((s, t) => s + (Number(t.fee) || 0), 0);
  const totalBuilder = shown.reduce((s, t) => s + (Number(t.builderFee) || 0), 0);

  return (
    <div className="text-[11.5px]">
      <div className="flex items-center justify-between border-b border-line bg-surface-2/30 px-4 py-1 text-[10px] text-fg-dim">
        <span>
          {shown.length} fill{shown.length === 1 ? "" : "s"} loaded
        </span>
        <span className="font-[var(--font-jetbrains-mono)] tabular-nums">
          Fees {money(totalFee)} · Builder {money(totalBuilder)}
        </span>
      </div>
      <div
        className="grid gap-2 border-b border-line px-4 py-1 text-[9px] uppercase tracking-wider text-fg-dim"
        style={{ gridTemplateColumns: TH_COLS }}
      >
        <span>Time</span>
        <span>Market</span>
        <span>Side</span>
        <span className="text-right">Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Value</span>
        <span className="text-right">Fee</span>
        <span className="text-right">Builder</span>
        <span className="text-right">Role</span>
      </div>
      {shown.map((t) => {
        const buy = sideIsBuy(t.side);
        const price = Number(t.price);
        const qty = Number(t.quantity);
        return (
          <div
            key={t.tradeID}
            className="grid items-center gap-2 px-4 py-1.5 font-[var(--font-jetbrains-mono)] tabular-nums hover:bg-surface-2/40"
            style={{ gridTemplateColumns: TH_COLS }}
          >
            <span className="text-fg-dim">{fmtDateTime(t.time)}</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <AssetLogo symbol={t.symbol} size={15} />
              <span className="truncate text-fg">{perpName(t.symbol)}</span>
            </span>
            <span className={buy ? "text-positive" : "text-negative"}>
              {buy ? "Buy" : "Sell"}
            </span>
            <span className="text-right">
              {fmtPrice(price, tickBySymbol[t.symbol.toUpperCase()])}
            </span>
            <span className="text-right">{qtyFmt(qty)}</span>
            <span className="text-right text-fg">{money(price * qty)}</span>
            <span className="text-right text-fg-muted">{money(Number(t.fee))}</span>
            <span className="text-right text-fg-muted">
              {t.builderFee ? money(Number(t.builderFee)) : "—"}
            </span>
            <span className="text-right text-fg-dim">{t.isMaker ? "Maker" : "Taker"}</span>
          </div>
        );
      })}
      {!done ? <div ref={sentinel} className="h-8" /> : null}
      {loadingMore ? (
        <div className="px-4 py-2 text-center text-[11px] text-fg-dim">Loading more…</div>
      ) : null}
    </div>
  );
}

const OH_COLS =
  "minmax(92px,1fr) minmax(70px,0.9fr) minmax(94px,1.25fr) 40px minmax(0,0.85fr) minmax(0,0.85fr) minmax(0,0.8fr) minmax(0,0.8fr) minmax(66px,0.85fr)";

/** Order History — filled / cancelled / rejected / triggered orders. */
function OrderHistoryView({
  address,
  currentOnly,
  selectedSymbol,
  refreshKey,
  tickBySymbol,
}: HistoryViewProps) {
  const load = useCallback(
    (addr: `0x${string}`) => getOrderHistory("mainnet", addr, { limit: 200 }),
    [],
  );
  const { rows, state, err } = useAccountHistory<SodexOrderHistory>(
    address,
    refreshKey,
    load,
  );
  const shown = rows.filter((o) =>
    symbolMatches(o.symbol, currentOnly, selectedSymbol),
  );
  if (state !== "ready") return <HistoryStatus state={state} err={err} />;
  if (shown.length === 0) return <Empty>No order history in this range.</Empty>;
  return (
    <div className="text-[11.5px]">
      <div
        className="grid gap-2 border-b border-line px-4 py-1 text-[9px] uppercase tracking-wider text-fg-dim"
        style={{ gridTemplateColumns: OH_COLS }}
      >
        <span>Time</span>
        <span>Market</span>
        <span>Type</span>
        <span>Side</span>
        <span className="text-right">Price</span>
        <span className="text-right">Trigger</span>
        <span className="text-right">Size</span>
        <span className="text-right">Filled</span>
        <span className="text-right">Status</span>
      </div>
      {shown.map((o) => {
        const buy = sideIsBuy(o.side);
        const { label: typeLabel, isStop } = orderTypeInfo(o);
        const reason = o.rejectReason || o.reason || o.text || "";
        return (
          <div
            key={o.orderID}
            className="grid items-center gap-2 px-4 py-1.5 font-[var(--font-jetbrains-mono)] tabular-nums hover:bg-surface-2/40"
            style={{ gridTemplateColumns: OH_COLS }}
          >
            <span className="text-fg-dim">{o.createdAt ? fmtDateTime(o.createdAt) : "—"}</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <AssetLogo symbol={o.symbol} size={15} />
              <span className="truncate text-fg">{perpName(o.symbol)}</span>
            </span>
            <span className="flex min-w-0 items-center gap-1 truncate">
              <span className={cn("truncate", isStop ? "text-fg" : "text-fg-muted")}>
                {typeLabel}
              </span>
              {o.reduceOnly ? (
                <span className="shrink-0 rounded bg-surface-2 px-1 text-[8px] uppercase tracking-wide text-fg-dim">
                  RO
                </span>
              ) : null}
            </span>
            <span className={buy ? "text-positive" : "text-negative"}>
              {buy ? "Buy" : "Sell"}
            </span>
            <span className="text-right text-fg-muted">
              {Number(o.price) > 0
                ? fmtPrice(Number(o.price), tickBySymbol[o.symbol.toUpperCase()])
                : "Market"}
            </span>
            <span className={cn("text-right", isStop ? "text-[#e0a53f]" : "text-fg-dim")}>
              {isStop && Number(o.stopPrice) > 0
                ? fmtPrice(Number(o.stopPrice), tickBySymbol[o.symbol.toUpperCase()])
                : "—"}
            </span>
            <span className="text-right">{o.origQty ? qtyFmt(Number(o.origQty)) : "—"}</span>
            <span className="text-right text-fg-muted">
              {filledFmt(o.executedQty, o.origQty)}
            </span>
            <span
              className={cn("truncate text-right", statusTone(o.status))}
              title={reason ? `${titleCase(o.status)} — ${reason}` : undefined}
            >
              {titleCase(o.status)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const CP_COLS =
  "minmax(84px,1fr) 46px minmax(0,0.9fr) minmax(0,0.95fr) minmax(0,0.95fr) minmax(0,1fr) minmax(90px,1fr) minmax(90px,1fr)";

/** Closed Positions — realized history from positions/history (active=false). */
function ClosedPositionsView({
  address,
  currentOnly,
  selectedSymbol,
  refreshKey,
  tickBySymbol,
}: HistoryViewProps) {
  const load = useCallback(
    (addr: `0x${string}`) => getPositionsHistory("mainnet", addr, { limit: 100 }),
    [],
  );
  const { rows, state, err } = useAccountHistory<SodexClosedPosition>(
    address,
    refreshKey,
    load,
  );
  const shown = rows.filter(
    (p) => !p.active && symbolMatches(p.symbol, currentOnly, selectedSymbol),
  );
  if (state !== "ready") return <HistoryStatus state={state} err={err} />;
  if (shown.length === 0) return <Empty>No closed positions in this range.</Empty>;
  return (
    <div className="text-[11.5px]">
      <div
        className="grid gap-2 border-b border-line px-4 py-1 text-[9px] uppercase tracking-wider text-fg-dim"
        style={{ gridTemplateColumns: CP_COLS }}
      >
        <span>Market</span>
        <span>Side</span>
        <span className="text-right">Size</span>
        <span className="text-right">Entry</span>
        <span className="text-right">Close</span>
        <span className="text-right">Realized PnL</span>
        <span className="text-right">Opened</span>
        <span className="text-right">Closed</span>
      </div>
      {shown.map((p) => {
        const isLong = (p.positionSide ?? "").toUpperCase() === "LONG";
        const pnl = Number(p.realizedPnL);
        const sizeStr = p.maxSize ?? p.cumClosedSize ?? p.size;
        return (
          <div
            key={p.id}
            className="grid items-center gap-2 px-4 py-1.5 font-[var(--font-jetbrains-mono)] tabular-nums hover:bg-surface-2/40"
            style={{ gridTemplateColumns: CP_COLS }}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <AssetLogo symbol={p.symbol} size={15} />
              <span className="truncate text-fg">{perpName(p.symbol)}</span>
            </span>
            <span className={isLong ? "text-positive" : "text-negative"}>
              {isLong ? "Long" : "Short"}
            </span>
            <span className="text-right text-fg-muted">
              {sizeStr ? qtyFmt(Number(sizeStr)) : "—"}
            </span>
            <span className="text-right text-fg-muted">
              {fmtPrice(Number(p.avgEntryPrice), tickBySymbol[p.symbol.toUpperCase()])}
            </span>
            <span className="text-right text-fg-muted">
              {Number(p.avgClosePrice) > 0
                ? fmtPrice(Number(p.avgClosePrice), tickBySymbol[p.symbol.toUpperCase()])
                : "—"}
            </span>
            <span
              className={cn(
                "text-right",
                pnl > 0 ? "text-positive" : pnl < 0 ? "text-negative" : "text-fg-muted",
              )}
            >
              {Number.isFinite(pnl) ? signedMoney(pnl) : "—"}
            </span>
            <span className="text-right text-fg-dim">{fmtDateTime(p.createdAt)}</span>
            <span className="text-right text-fg-dim">{fmtDateTime(p.updatedAt)}</span>
          </div>
        );
      })}
    </div>
  );
}
