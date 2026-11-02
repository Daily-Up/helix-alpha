"use client";

/**
 * BottomPanel — the terminal's Positions / Balances / Open Orders / Trade
 * History tabs, wired to the live perps account state (fetched in the
 * parent). Each tab shows a count badge; disconnected or empty tabs show a
 * short empty state with a Connect SoDEX CTA.
 */

import Link from "next/link";
import { cn } from "@/components/ui/cn";
import type { SodexPerpsAccountState } from "@/lib/sodex-onchain/types";

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

export function BottomPanel({
  tab,
  setTab,
  account,
  ready,
  markPrice,
  digits,
}: {
  tab: BottomTab;
  setTab: (t: BottomTab) => void;
  account: SodexPerpsAccountState | null;
  ready: boolean;
  markPrice: number | null;
  digits: number;
}) {
  const positions = (account?.P ?? []).filter((p) => Number(p.sz) !== 0);
  const balances = (account?.B ?? []).filter((b) => Number(b.wb) > 0);
  const openOrders = (account?.O as unknown[]) ?? [];

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
              head={["Market", "Size", "Entry", "uPNL"]}
              rows={positions.map((p) => {
                const sz = Number(p.sz);
                const entry = Number(p.ep);
                const upnl =
                  markPrice != null && entry > 0
                    ? (markPrice - entry) * sz
                    : null;
                return [
                  <span key="m" className="text-fg">
                    {p.s}
                  </span>,
                  <span
                    key="s"
                    className={sz >= 0 ? "text-positive" : "text-negative"}
                  >
                    {sz >= 0 ? "+" : ""}
                    {qtyFmt(sz)}
                  </span>,
                  <span key="e">{entry.toFixed(digits)}</span>,
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
            // TODO: SoDEX's perps account `O` entries aren't a documented
            // shape yet, and there is no cancelOrder action in the client —
            // adding a cancel signing path needs explicit sign-off. For now
            // show the count; detailed rows + Cancel are a follow-up.
            <Empty>
              {openOrders.length} open order
              {openOrders.length === 1 ? "" : "s"} — detailed rows &amp; cancel
              coming soon.
            </Empty>
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
