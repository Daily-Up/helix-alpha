"use client";

/**
 * PerpsTab — the portfolio's Perpetuals view. Four stat cards (Perps Equity,
 * 30d Perps Volume, 30d Realized PnL, Unrealized PnL), then the terminal's own
 * BottomPanel (Positions | Open Orders | Trade History | Order History | Closed
 * Positions | Funding) reused verbatim via the shared useSodexTradeActions hook
 * — same columns, same TP/SL + Close modals, same per-row Cancel / Close All.
 *
 * Account state is polled by the parent and passed in; the hook owns the open
 * orders, marks/funding and the order handlers. No selected-market context here
 * (no chart), so the market name links out to the terminal.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { CheckCircle2, XCircle, AlertTriangle, Info } from "lucide-react";
import { BottomPanel, type BottomTab } from "@/components/trade/BottomPanel";
import {
  useSodexTradeActions,
  type SymbolMeta,
} from "@/lib/sodex-onchain/useSodexTradeActions";
import type { SodexPerpsAccountState } from "@/lib/sodex-onchain/types";
import type { TradeModeState } from "@/lib/sodex-onchain/useTradeMode";
import type { EquityComposition, TradeStats } from "@/lib/portfolio/fetch";
import { StatCard } from "./StatCard";
import { money, signedMoney, compactUsd } from "./fmt";

export function PerpsTab({
  tm,
  account,
  refreshAccount,
  symbolMeta,
  composition,
  tradeStats,
}: {
  tm: TradeModeState;
  account: SodexPerpsAccountState | null;
  refreshAccount: () => void;
  symbolMeta: Record<string, SymbolMeta>;
  composition: EquityComposition | null;
  tradeStats: TradeStats | null;
}) {
  const router = useRouter();
  const { address: connectedMaster } = useAccount();
  const [tab, setTab] = useState<BottomTab>("Positions");

  // 1s clock for the funding countdown (same cadence the terminal uses).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Transient toast for cancel/close errors (the panel has no error line).
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

  const ta = useSodexTradeActions({
    account,
    refreshAccount,
    symbolMeta,
    tm,
    connectedMaster,
    showToast,
    fundingTabActive: tab === "Funding",
  });

  const perpsEquity =
    composition?.perps_equity ?? (account ? Number(account.av) : null);
  const uPnl =
    composition?.perps_upnl ??
    (account?.P
      ? account.P.reduce((s, p) => s + (p.ur != null ? Number(p.ur) : 0), 0)
      : null);
  const realized = tradeStats?.perpsRealized30d ?? null;

  return (
    <div className="flex flex-col gap-4">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Perps Equity" value={money(perpsEquity)} />
        <StatCard
          label="30d Perps Volume"
          value={tradeStats != null ? compactUsd(tradeStats.volume30d.perps) : "—"}
        />
        <StatCard
          label="30d Realized PnL"
          value={realized != null ? signedMoney(realized) : "—"}
          tone={
            realized == null || realized === 0
              ? "default"
              : realized > 0
                ? "positive"
                : "negative"
          }
        />
        <StatCard
          label="Unrealized PnL"
          value={signedMoney(uPnl)}
          tone={
            uPnl == null || uPnl === 0
              ? "default"
              : uPnl > 0
                ? "positive"
                : "negative"
          }
        />
      </div>

      {/* Reused terminal bottom panel — same columns, TP/SL + Close modals. */}
      <div className="relative h-[460px] overflow-hidden rounded-lg border border-line bg-surface">
        <BottomPanel
          tab={tab}
          setTab={setTab}
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

      {toast ? <Toast msg={toast} /> : null}
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
