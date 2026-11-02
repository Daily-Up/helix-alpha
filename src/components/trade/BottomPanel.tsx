"use client";

/**
 * BottomPanel — the terminal's Positions / Open Orders / Trade History /
 * Funding / Order History tabs, wired to the live perps account state
 * (fetched in the parent). A toolbar on the right of the tab bar filters to
 * the current market and closes every position. Disconnected or empty tabs
 * show a short empty state with a Connect SoDEX CTA.
 */

import { useEffect, useState } from "react";
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
// Signed $ whose precision scales to the (usually tiny) funding amount.
const fundingFmt = (v: number) => {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const dp = a >= 1 ? 2 : a >= 0.01 ? 3 : 4;
  return `${v < 0 ? "−" : "+"}$${a.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
};
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
  /** Place/modify TP & SL (place new, then cancel old). */
  onSet: (
    pos: Position,
    next: { tp: number | null; sl: number | null },
    existing: { tpOrderId: number | null; slOrderId: number | null },
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Cancel one resting trigger order (per-row "Remove"). */
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
  fundingBySymbol,
  fundingInterval,
  accountFundings,
  now,
  selectedSymbol,
  tpsl,
  ready,
  digits,
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
              digits={digits}
              currentOnly={currentOnly}
              selectedSymbol={selectedSymbol}
            />
          )
        ) : tab === "Trade History" ? (
          // TODO: wire to /api/sodex/my-trades (Helix's executed-trade log).
          <Empty>Trade history coming soon.</Empty>
        ) : tab === "Funding" ? (
          <FundingView
            positions={positions}
            markBySymbol={markBySymbol}
            fundingBySymbol={fundingBySymbol}
            fundingInterval={fundingInterval}
            fundings={accountFundings}
            now={now}
          />
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
  digits,
  markBySymbol,
  fundingBySymbol,
  now,
  selectedSymbol,
  tpsl,
  onSelect,
  onClose,
}: {
  positions: Position[];
  orders: SodexOpenOrder[];
  digits: number;
  markBySymbol: Record<string, number>;
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
        const { tp, sl } = tpslFor(p, orders);

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
            {/* Funding — est. next payment for THIS position (size × mark ×
                rate), signed: longs pay when the rate is positive. */}
            <FundingCell
              notional={value}
              isLong={isLong}
              funding={fundingBySymbol[p.s.toUpperCase()]}
              now={now}
            />
            {/* SL */}
            <TriggerCell value={sl} tone="neg" px={px} onEdit={() => openModal(p, "sl")} />
            {/* TP */}
            <TriggerCell value={tp} tone="pos" px={px} onEdit={() => openModal(p, "tp")} />
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
          onRemove={tpsl.onRemove}
          onClose={() => setModal(null)}
        />
      ) : null}
    </div>
  );
}

/** One SL or TP cell: the trigger price (or "-") + a pencil that opens the modal. */
function TriggerCell({
  value,
  tone,
  px,
  onEdit,
}: {
  value: number | null;
  tone: "pos" | "neg";
  px: (v: number) => string;
  onEdit: () => void;
}) {
  return (
    <span className="flex items-center justify-end gap-1 text-right">
      <span className={cn("tabular-nums", tone === "pos" ? "text-positive" : "text-negative")}>
        {value != null ? px(value) : "-"}
      </span>
      <button
        onClick={onEdit}
        title="Set TP / SL"
        className="rounded border border-line px-1 text-[10px] text-fg-dim transition-colors hover:text-fg"
      >
        ✎
      </button>
    </span>
  );
}

/** Positions "Funding" cell — est. next funding for the position, signed
 *  (green = you receive, red = you pay), with rate + countdown on hover. */
function FundingCell({
  notional,
  isLong,
  funding,
  now,
}: {
  notional: number | null;
  isLong: boolean;
  funding: FundingInfo | undefined;
  now: number;
}) {
  if (!funding || notional == null || !Number.isFinite(notional)) {
    return (
      <span className="text-right text-fg-dim" title="Funding rate unavailable">
        —
      </span>
    );
  }
  const est = fundingEst(notional, isLong, funding.rate);
  const ratePct = funding.rate * 100;
  const nextMs = nextFundingMs(funding.next);
  const cd = nextMs > 0 ? fmtCountdown(nextMs - now) : null;
  const title =
    `Est. next funding ${fundingFmt(est)} — rate ${ratePct >= 0 ? "+" : ""}` +
    `${ratePct.toFixed(4)}% per interval${cd ? `, next in ${cd}` : ""}`;
  return (
    <span
      className={cn(
        "text-right",
        est > 0 ? "text-positive" : est < 0 ? "text-negative" : "text-fg-muted",
      )}
      title={title}
    >
      {fundingFmt(est)}
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
  digits,
  busy,
  scopeLabel,
  onConfirm,
  onClose,
}: {
  orders: SodexOpenOrder[];
  digits: number;
  busy: boolean;
  scopeLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const px = (v?: string) =>
    v != null && Number.isFinite(Number(v))
      ? Number(v).toLocaleString(undefined, {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })
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
            const buy = o.side === SodexSide.BUY;
            const isLimit = o.type === SodexOrderType.LIMIT;
            return (
              <div
                key={o.orderID}
                className="flex items-center justify-between py-1 font-[var(--font-jetbrains-mono)] text-[11.5px] tabular-nums"
              >
                <span className="flex items-center gap-2">
                  <span className="text-fg">{baseOf(o.symbol)}</span>
                  <span className={buy ? "text-positive" : "text-negative"}>
                    {buy ? "Buy" : "Sell"}
                  </span>
                  <span className="text-[9px] text-fg-dim">{isLimit ? "LMT" : "MKT"}</span>
                </span>
                <span className="text-fg-muted">
                  {o.origQty ? qtyFmt(Number(o.origQty)) : "—"}
                  {Number(o.price) > 0 ? ` @ ${px(o.price)}` : ""}
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

const OO_COLS =
  "minmax(56px,1fr) 60px minmax(0,1fr) minmax(0,1fr) minmax(0,0.85fr) minmax(0,0.95fr) 56px";

function OpenOrders({
  orders,
  onCancel,
  busy,
  digits,
  currentOnly,
  selectedSymbol,
}: {
  orders: SodexOpenOrder[];
  onCancel: (orders: SodexOpenOrder[]) => void;
  busy: boolean;
  digits: number;
  /** Whether the panel's "Current market only" filter is on. */
  currentOnly: boolean;
  selectedSymbol: string | null;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const px = (v?: string) =>
    v != null && Number.isFinite(Number(v))
      ? Number(v).toLocaleString(undefined, {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })
      : "—";
  // Orders can span markets (account-wide), so label the header by distinct
  // market count unless they all share one symbol.
  const markets = new Set(orders.map((o) => (o.symbol ?? "").toUpperCase()));
  const header =
    markets.size === 1 ? perpName(orders[0]?.symbol ?? "") : `${markets.size} markets`;
  // "Cancel all" obeys the same filter the list is already showing: scoped to
  // the selected market when "Current market only" is on, else every market.
  const cancelAllLabel = currentOnly
    ? `Cancel all (${perpName(selectedSymbol ?? "")})`
    : `Cancel all (${orders.length} orders, all markets)`;
  return (
    <div className="text-[11.5px]">
      <div className="flex items-center justify-between border-b border-line px-4 py-1.5">
        <span className="text-[9px] uppercase tracking-wider text-fg-dim">
          {orders.length} open · {header}
        </span>
        <button
          onClick={() => setConfirmOpen(true)}
          disabled={busy || orders.length === 0}
          className="rounded border border-line px-2 py-0.5 text-[10px] text-fg-muted transition-colors hover:border-negative/40 hover:text-negative disabled:opacity-50"
        >
          {busy ? "Cancelling…" : cancelAllLabel}
        </button>
      </div>
      {confirmOpen ? (
        <CancelAllConfirm
          orders={orders}
          digits={digits}
          busy={busy}
          scopeLabel={currentOnly ? perpName(selectedSymbol ?? "") : "all markets"}
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
        <span>Market</span>
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
            <span className="truncate text-fg-muted">{baseOf(o.symbol)}</span>
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
