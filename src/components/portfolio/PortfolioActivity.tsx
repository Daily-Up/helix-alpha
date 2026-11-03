"use client";

/**
 * PortfolioActivity — the portfolio's lower section: one SoDEX-style tab bar
 * over Balances (the unified holdings table), the terminal's live trading tabs
 * (Positions / Open Orders / Trade History / Funding History / Order History /
 * Position History — the reused BottomPanel, chromeless), and a Deposits &
 * Withdrawals empty state (SoDEX's trading REST exposes no transfer-history
 * read). The trade-actions hook (open orders, marks, Close/TP-SL) is owned here,
 * exactly as the Perpetuals tab did. Read-only except the same Close / Cancel
 * actions the terminal already offers.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { CheckCircle2, XCircle, AlertTriangle, Info } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { BottomPanel, type BottomTab } from "@/components/trade/BottomPanel";
import {
  useSodexTradeActions,
  type SymbolMeta,
} from "@/lib/sodex-onchain/useSodexTradeActions";
import type { SodexPerpsAccountState } from "@/lib/sodex-onchain/types";
import type { TradeModeState } from "@/lib/sodex-onchain/useTradeMode";
import type { UnifiedHolding } from "@/lib/portfolio/fetch";
import { BalancesTable } from "./BalancesTable";

const PORTFOLIO_TABS = [
  "Balances",
  "Positions",
  "Open Orders",
  "Trade History",
  "Funding History",
  "Order History",
  "Position History",
  "Deposits & Withdrawals",
] as const;
type PortfolioTab = (typeof PORTFOLIO_TABS)[number];

/** Portfolio tab → the terminal BottomPanel tab that renders it. */
const TO_BOTTOM: Partial<Record<PortfolioTab, BottomTab>> = {
  Positions: "Positions",
  "Open Orders": "Open Orders",
  "Trade History": "Trade History",
  "Funding History": "Funding",
  "Order History": "Order History",
  "Position History": "Closed Positions",
};
const FROM_BOTTOM: Record<BottomTab, PortfolioTab> = {
  Positions: "Positions",
  "Open Orders": "Open Orders",
  "Trade History": "Trade History",
  Funding: "Funding History",
  "Order History": "Order History",
  "Closed Positions": "Position History",
};

export function PortfolioActivity({
  tm,
  account,
  refreshAccount,
  symbolMeta,
  holdings,
  totalUsd,
  balancesLoading,
  onRefreshBalances,
  balancesRefreshing,
}: {
  tm: TradeModeState;
  account: SodexPerpsAccountState | null;
  refreshAccount: () => void;
  symbolMeta: Record<string, SymbolMeta>;
  holdings: UnifiedHolding[] | null;
  totalUsd: number;
  balancesLoading: boolean;
  onRefreshBalances: () => void;
  balancesRefreshing: boolean;
}) {
  const router = useRouter();
  const { address: connectedMaster } = useAccount();
  const [tab, setTab] = useState<PortfolioTab>("Balances");

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const bottomTab = TO_BOTTOM[tab];
  const ta = useSodexTradeActions({
    account,
    refreshAccount,
    symbolMeta,
    tm,
    connectedMaster,
    showToast,
    fundingTabActive: bottomTab === "Funding",
  });

  const positionCount = (account?.P ?? []).filter(
    (p) => Number(p.sz) !== 0,
  ).length;
  const countFor = (t: PortfolioTab): number | null =>
    t === "Balances"
      ? (holdings?.length ?? 0)
      : t === "Positions"
        ? positionCount
        : t === "Open Orders"
          ? ta.openOrders.length
          : null;

  return (
    <div className="rounded-lg border border-line bg-surface">
      {/* Unified tab bar */}
      <div className="flex items-center gap-4 overflow-x-auto border-b border-line px-4 py-2.5 text-[12px]">
        {PORTFOLIO_TABS.map((t) => {
          const c = countFor(t);
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "relative flex shrink-0 items-center gap-1.5 whitespace-nowrap transition-colors",
                tab === t
                  ? "font-medium text-fg"
                  : "text-fg-dim hover:text-fg-muted",
              )}
            >
              {t}
              {c != null && c > 0 ? (
                <span className="rounded bg-surface-2 px-1 text-[10px] tabular-nums text-fg-muted">
                  {c}
                </span>
              ) : null}
              <span
                aria-hidden
                className="absolute inset-x-0 -bottom-[11px] h-[2px] rounded-full transition-opacity duration-150"
                style={{
                  backgroundColor: "var(--accent-trade)",
                  opacity: tab === t ? 1 : 0,
                }}
              />
            </button>
          );
        })}
      </div>

      <div className="p-4">
        {tab === "Balances" ? (
          <BalancesTable
            holdings={holdings}
            totalUsd={totalUsd}
            loading={balancesLoading}
            onRefresh={onRefreshBalances}
            refreshing={balancesRefreshing}
          />
        ) : tab === "Deposits & Withdrawals" ? (
          <DepositsEmpty />
        ) : bottomTab ? (
          <div className="relative h-[460px] overflow-hidden rounded-lg border border-line bg-surface-2/20">
            <BottomPanel
              hideTabBar
              tab={bottomTab}
              setTab={(bt) => setTab(FROM_BOTTOM[bt])}
              account={account}
              openOrders={ta.openOrders}
              onCancel={ta.onCancelOrders}
              cancelBusy={ta.cancelBusy}
              onSelectSymbol={() => router.push("/trade")}
              onClosePosition={ta.onClosePosition}
              onCloseAll={ta.onCloseAll}
              closeAllBusy={ta.closeAllBusy}
              markBySymbol={ta.markBySymbol}
              tickBySymbol={ta.tickBySymbol}
              fundingBySymbol={ta.fundingBySymbol}
              fundingInterval={3600}
              accountFundings={ta.accountFundings}
              now={now}
              selectedSymbol={null}
              tpsl={ta.tpslCtx}
              ready={tm.ready}
              digits={2}
              address={tm.address ?? null}
              historyRefreshKey={ta.historyRefreshKey}
            />
          </div>
        ) : null}
      </div>

      {toast ? <Toast msg={toast} /> : null}
    </div>
  );
}

function DepositsEmpty() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-[12px] text-fg-dim">
      <span className="max-w-md">
        SoDEX&apos;s trading API exposes no transfer-history read, so deposits
        and withdrawals aren&apos;t listed here. View them on SoDEX.
      </span>
      <a
        href="https://sodex.com/portfolio"
        target="_blank"
        rel="noopener noreferrer"
        className="rounded-md border border-line px-3 py-1.5 text-[12px] font-medium text-fg-muted transition-colors hover:border-line-2 hover:text-fg"
      >
        Open SoDEX portfolio →
      </a>
    </div>
  );
}

/** Minimal transient toast — mirrors the terminal's icon/colour treatment. */
function Toast({ msg }: { msg: string }) {
  const kind = msg.startsWith("✓")
    ? "ok"
    : msg.startsWith("✗")
      ? "err"
      : msg.startsWith("⚠")
        ? "warn"
        : "info";
  const body = msg.replace(/^[✓✗⚠]\s*/, "");
  const color =
    kind === "ok"
      ? "#0ecb81"
      : kind === "err"
        ? "#f6465d"
        : kind === "warn"
          ? "#e0a53f"
          : "var(--accent-trade)";
  const Icon =
    kind === "ok"
      ? CheckCircle2
      : kind === "err"
        ? XCircle
        : kind === "warn"
          ? AlertTriangle
          : Info;
  const title =
    kind === "ok"
      ? "Done"
      : kind === "err"
        ? "Failed"
        : kind === "warn"
          ? "Heads up"
          : "Notice";
  return (
    <div
      role="status"
      className="trade-modal-panel fixed bottom-5 right-5 z-[100] flex max-w-[360px] items-start gap-2.5 rounded-lg border border-line bg-surface-2 px-3.5 py-3 shadow-2xl shadow-black/50"
    >
      <Icon size={17} strokeWidth={2.25} style={{ color }} className="mt-px shrink-0" />
      <div className="min-w-0">
        <div className="text-[12px] font-semibold" style={{ color }}>
          {title}
        </div>
        <div className="mt-0.5 break-words text-[12px] leading-snug text-fg-muted">
          {body}
        </div>
      </div>
    </div>
  );
}
