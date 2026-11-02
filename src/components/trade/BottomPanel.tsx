"use client";

/**
 * BottomPanel — the terminal's Positions / Balances / Open Orders / Trade
 * History tabs, wired to the live perps account state (fetched in the
 * parent). Each tab shows a count badge; disconnected or empty tabs show a
 * short empty state with a Connect SoDEX CTA.
 */

import Link from "next/link";
import { cn } from "@/components/ui/cn";
import {
  SodexSide,
  SodexOrderType,
  type SodexPerpsAccountState,
  type SodexOpenOrder,
} from "@/lib/sodex-onchain/types";

export const BOTTOM_TABS = [
  "Positions",
  "Balances",
  "Open Orders",
  "Trade History",
] as const;
export type BottomTab = (typeof BOTTOM_TABS)[number];

const money = (v: number, d = 2) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const qtyFmt = (v: number) =>
  v.toLocaleString(undefined, { maximumFractionDigits: 6 });
const two = (n: number) => String(n).padStart(2, "0");
const fmtTime = (t: number) => {
  const d = new Date(t < 1e12 ? t * 1000 : t); // accept seconds or ms
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

export function BottomPanel({
  tab,
  setTab,
  account,
  openOrders,
  onCancel,
  cancelBusy,
  ready,
  digits,
}: {
  tab: BottomTab;
  setTab: (t: BottomTab) => void;
  account: SodexPerpsAccountState | null;
  openOrders: SodexOpenOrder[];
  onCancel: (orderIDs: number[]) => void;
  cancelBusy: boolean;
  ready: boolean;
  digits: number;
}) {
  const positions = (account?.P ?? []).filter((p) => Number(p.sz) !== 0);
  const balances = (account?.B ?? []).filter((b) => Number(b.wb) > 0);

  const counts: Record<BottomTab, number> = {
    Positions: positions.length,
    Balances: balances.length,
    "Open Orders": openOrders.length,
    "Trade History": 0,
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-5 border-b border-line px-4 py-2 text-[12px]">
        {BOTTOM_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "flex items-center gap-1.5 transition-colors",
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!ready ? (
          <Empty cta>
            Connect a SoDEX wallet to view your {tab.toLowerCase()}.
          </Empty>
        ) : tab === "Positions" ? (
          positions.length === 0 ? (
            <Empty>No open positions.</Empty>
          ) : (
            <Table
              head={["Market", "Size", "Entry", "Liq", "Lev", "uPNL"]}
              rows={positions.map((p) => {
                const sz = Number(p.sz);
                const entry = Number(p.ep);
                // Use SoDEX's authoritative values from /state (not estimates).
                const liq = p.lp ? Number(p.lp) : null;
                const upnl = p.ur != null ? Number(p.ur) : null;
                const lev = p.l ?? null;
                const mode = p.m
                  ? p.m.charAt(0) + p.m.slice(1).toLowerCase()
                  : "";
                const px = (v: number) =>
                  v.toLocaleString(undefined, {
                    minimumFractionDigits: digits,
                    maximumFractionDigits: digits,
                  });
                return [
                  <span key="m" className="text-fg">
                    {p.s}
                    {mode ? (
                      <span className="ml-1 text-[9px] text-fg-dim">{mode}</span>
                    ) : null}
                  </span>,
                  <span
                    key="s"
                    className={sz >= 0 ? "text-positive" : "text-negative"}
                  >
                    {sz >= 0 ? "+" : ""}
                    {qtyFmt(sz)}
                  </span>,
                  <span key="e">{px(entry)}</span>,
                  <span key="lq" className="text-fg-muted">
                    {liq != null ? px(liq) : "—"}
                  </span>,
                  <span key="lv">{lev != null ? `${lev}×` : "—"}</span>,
                  <span
                    key="u"
                    className={
                      upnl == null
                        ? "text-fg-dim"
                        : upnl >= 0
                          ? "text-positive"
                          : "text-negative"
                    }
                  >
                    {upnl == null
                      ? "—"
                      : `${upnl >= 0 ? "+" : ""}${money(upnl)}`}
                  </span>,
                ];
              })}
            />
          )
        ) : tab === "Balances" ? (
          balances.length === 0 ? (
            <Empty>No balances.</Empty>
          ) : (
            <Table
              head={["Asset", "Wallet", "Available"]}
              rows={balances.map((b) => [
                <span key="a" className="text-fg">
                  {b.a}
                </span>,
                <span key="w">{qtyFmt(Number(b.wb))}</span>,
                <span key="av">{b.aw != null ? qtyFmt(Number(b.aw)) : "—"}</span>,
              ])}
            />
          )
        ) : tab === "Open Orders" ? (
          openOrders.length === 0 ? (
            <Empty>No open orders.</Empty>
          ) : (
            <OpenOrders
              orders={openOrders}
              onCancel={onCancel}
              busy={cancelBusy}
              digits={digits}
            />
          )
        ) : (
          // Trade History — TODO: wire to /api/sodex/my-trades (Helix's
          // executed-trade log, keyed by wallet). Empty for now.
          <Empty>Trade history coming soon.</Empty>
        )}
      </div>
    </div>
  );
}

function Empty({
  children,
  cta,
}: {
  children: React.ReactNode;
  cta?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-[12px] text-fg-dim">
      <span>{children}</span>
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

function Table({
  head,
  rows,
}: {
  head: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <div className="text-[11.5px]">
      <div
        className="grid gap-2 border-b border-line px-4 py-1.5 text-[9px] uppercase tracking-wider text-fg-dim"
        style={{ gridTemplateColumns: `repeat(${head.length}, 1fr)` }}
      >
        {head.map((h, i) => (
          <span key={i} className={i === 0 ? "" : "text-right"}>
            {h}
          </span>
        ))}
      </div>
      {rows.map((cells, r) => (
        <div
          key={r}
          className="grid gap-2 px-4 py-1.5 font-[var(--font-jetbrains-mono)] tabular-nums hover:bg-surface-2/40"
          style={{ gridTemplateColumns: `repeat(${head.length}, 1fr)` }}
        >
          {cells.map((c, i) => (
            <span key={i} className={i === 0 ? "" : "text-right"}>
              {c}
            </span>
          ))}
        </div>
      ))}
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
              <span className="ml-1 text-[9px] text-fg-dim">
                {isLimit ? "LMT" : "MKT"}
              </span>
            </span>
            <span className="text-right">{px(o.price)}</span>
            <span className="text-right">
              {o.origQty ? qtyFmt(Number(o.origQty)) : "—"}
            </span>
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
