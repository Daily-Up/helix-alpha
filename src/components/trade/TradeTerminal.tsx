"use client";

/**
 * TradeTerminal — exchange-grade perp/spot terminal (TrueNorth/Arcus style).
 *
 * Header carries the full SoDEX stat row (Mark · Oracle · 24h Change · 24h
 * Volume · Open Interest · Funding/Countdown for perps). Body: candlestick
 * + volume chart, live SoDEX order book (Price/Size/Total), and a
 * Cross-leverage order ticket. "AI Setup" runs Helix's news-grounded call
 * and draws its levels on the chart. Bottom: positions/balances tabs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { AssetLogo } from "@/components/ui/AssetLogo";
import { CheckCircle2, XCircle, AlertTriangle, Info } from "lucide-react";
import { AssetPicker } from "./AssetPicker";
import { SetupCard, type SetupResponse } from "./SetupCard";
import { PriceChart } from "./PriceChart";
import { OrderBook, type BookLevel } from "./OrderBook";
import { OrderPanel, type SymbolRules } from "./OrderPanel";
import { AccountPanel } from "./AccountPanel";
import type { Trade } from "./TradesTape";
import { BottomPanel, type BottomTab } from "./BottomPanel";
import { useTradeMode } from "@/lib/sodex-onchain/useTradeMode";
import { getPerpsAccountState } from "@/lib/sodex-onchain/client";
import {
  useSodexTradeActions,
  type SymbolMeta,
} from "@/lib/sodex-onchain/useSodexTradeActions";
import { useAccount } from "wagmi";
import type {
  SodexPerpsAccountState,
  SodexOpenOrder,
} from "@/lib/sodex-onchain/types";

export interface TerminalAsset {
  id: string;
  symbol: string;
  name: string;
  kind: string;
  sodex_symbol: string | null;
  market: "spot" | "perp" | null;
}

// SymbolMeta now lives with the shared trade-actions hook (so the hook and its
// consumers share one definition); re-exported here so existing imports
// (src/app/trade/page.tsx) keep working unchanged.
export type { SymbolMeta };

interface Ticker {
  lastPx: string;
  quoteVolume: string;
  highPx: string;
  lowPx: string;
  change: string;
  changePct: number;
  // perps-only
  markPrice?: string;
  indexPrice?: string;
  openInterest?: string;
  fundingRate?: string;
  nextFundingTime?: number;
}

const num = (v: string | undefined) => (v == null ? null : Number(v));
const fmt = (v: number | null, d = 2) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtUsd = (v: number | null) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : v >= 1e9
      ? `$${(v / 1e9).toFixed(2)}B`
      : v >= 1e6
        ? `$${(v / 1e6).toFixed(2)}M`
        : v >= 1e3
          ? `$${(v / 1e3).toFixed(2)}K`
          : `$${v.toFixed(0)}`;

const MIN_BOTTOM = 120;
const DEFAULT_BOTTOM = 220;
const clampBottom = (h: number) => {
  const vh = typeof window !== "undefined" ? window.innerHeight : 900;
  return Math.max(MIN_BOTTOM, Math.min(h, vh * 0.5));
};

export function TradeTerminal({
  assets,
  symbolMeta = {},
  initialAssetId,
  initialSide,
  initialSource,
}: {
  assets: TerminalAsset[];
  symbolMeta?: Record<string, SymbolMeta>;
  /** Pre-select this asset (e.g. from an Event Stream trade link). */
  initialAssetId?: string;
  /** Preset the ticket side (no auto-size, no auto-submit). */
  initialSide?: "buy" | "sell";
  /** "event" when reached from an Event Stream deep-link — tags only the
   *  first order's clOrdID ("helix-evt-"), then clears. */
  initialSource?: "event";
}) {
  const tm = useTradeMode("mainnet");
  const [assetId, setAssetId] = useState<string>(
    () =>
      (initialAssetId && assets.some((a) => a.id === initialAssetId)
        ? initialAssetId
        : null) ??
      assets.find((a) => a.id === "tok-btc")?.id ??
      assets[0]?.id ??
      "",
  );
  // Event Stream attribution tag. Single-use: cleared after the first order
  // (OrderPanel → onSourceConsumed) or a manual market/side switch, so later
  // unrelated trades are never tagged "helix-evt-".
  const [source, setSource] = useState<"event" | undefined>(initialSource);
  const selected = assets.find((a) => a.id === assetId) ?? null;
  const sodexSymbol = selected?.sodex_symbol ?? null;
  const market = selected?.market ?? "spot";
  const isPerp = market === "perp";

  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [bids, setBids] = useState<BookLevel[]>([]);
  const [asks, setAsks] = useState<BookLevel[]>([]);
  const [mktLoading, setMktLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [bottomTab, setBottomTab] = useState<BottomTab>("Positions");
  const [rules, setRules] = useState<SymbolRules | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [limitFill, setLimitFill] = useState<number | null>(null);
  // Live perps account state stays here (read by the ticket, account panel,
  // chart lines + the all-marks poll inside the hook); the open orders, marks,
  // funding, busy flags, history key and the cancel/close/TP-SL handlers live in
  // the shared useSodexTradeActions hook (wired just below).
  const [account, setAccount] = useState<SodexPerpsAccountState | null>(null);
  const { address: connectedMaster } = useAccount();

  // Transient terminal toast (errors like an un-resolvable cancel). Auto-clears.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);
  const [bottomH, setBottomH] = useState(DEFAULT_BOTTOM);
  // Until the user drags the divider, the panel height auto-fits the active
  // tab's rows (min ~3 rows, max the usual cap); a dragged height then wins.
  const [userDraggedBottom, setUserDraggedBottom] = useState(false);
  const [sideFill, setSideFill] = useState<{
    side: "buy" | "sell";
    seq: number;
  } | null>(() => (initialSide ? { side: initialSide, seq: 1 } : null));
  const onMobileSide = (side: "buy" | "sell") => {
    setSideFill((p) => ({ side, seq: (p?.seq ?? 0) + 1 }));
    setSource(undefined); // manual side switch drops the Event Stream tag
    document
      .getElementById("terminal-ticket")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // 1s clock for the funding countdown.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!sodexSymbol) return;
    let cancelled = false;
    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      setMktLoading(true);
      try {
        const r = await fetch(
          `/api/sodex/market?symbol=${encodeURIComponent(sodexSymbol)}&market=${market}`,
        );
        const j = await r.json();
        if (cancelled || !j.ok) return;
        // Coalesce the book/ticker updates into one frame.
        requestAnimationFrame(() => {
          if (cancelled) return;
          setTicker(j.ticker);
          setBids(j.bids ?? []);
          setAsks(j.asks ?? []);
        });
      } catch {
        /* keep last good values */
      } finally {
        if (!cancelled) setMktLoading(false);
      }
    };
    setTicker(null);
    setBids([]);
    setAsks([]);
    load();
    const t = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sodexSymbol, market]);

  // Symbol trading rules (fees / leverage / margin tiers / precision), once
  // per symbol — shared by the ticket (fees, liq) and the book (grouping).
  useEffect(() => {
    if (!sodexSymbol) {
      setRules(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/sodex/rules?symbol=${encodeURIComponent(sodexSymbol)}&market=${isPerp ? "perp" : "spot"}`,
        );
        const j = await r.json();
        if (!cancelled && j.ok) setRules(j.rules as SymbolRules);
      } catch {
        /* keep last */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sodexSymbol, isPerp]);

  // Trades tape — polled, rAF-batched like the book.
  useEffect(() => {
    if (!sodexSymbol) return;
    let cancelled = false;
    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      setTradesLoading(true);
      try {
        const r = await fetch(
          `/api/sodex/trades?symbol=${encodeURIComponent(sodexSymbol)}&market=${market}&limit=40`,
        );
        const j = await r.json();
        if (cancelled || !j.ok) return;
        requestAnimationFrame(() => {
          if (!cancelled) setTrades(j.trades ?? []);
        });
      } catch {
        /* keep last */
      } finally {
        if (!cancelled) setTradesLoading(false);
      }
    };
    setTrades([]);
    load();
    const t = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sodexSymbol, market]);

  // Live perps account state (positions / balances / margin) for the ticket
  // and the bottom tabs. Read-only, polled; only when the browser is live.
  // Exposed as a callback so an order flow can re-sync positions immediately
  // (an unconfirmed or partial fill must reflect SoDEX, not wait for the poll).
  const refreshAccount = useCallback(async () => {
    if (!tm.ready || !tm.address) {
      setAccount(null);
      return;
    }
    try {
      const st = await getPerpsAccountState(
        "mainnet",
        tm.address as `0x${string}`,
      );
      setAccount(st);
    } catch {
      /* keep last good */
    }
  }, [tm.ready, tm.address]);
  useEffect(() => {
    refreshAccount();
    const t = setInterval(refreshAccount, 5000);
    return () => clearInterval(t);
  }, [refreshAccount]);

  // Selected-market price anchors. Mark = perp mark price, else last; oracle
  // from the index; mid from the top of book. These feed both the header and
  // the shared trade-actions hook (so the Positions/Close context stays exactly
  // in sync with the ticket). Computed before the hook so it can overlay the
  // selected market's live mark onto the account-wide marks map.
  const mark = num(ticker?.markPrice) ?? num(ticker?.lastPx);
  const digits = mark != null && mark < 10 ? 4 : 2;
  const oracle = num(ticker?.indexPrice);
  const lastPrice = num(ticker?.lastPx);
  const bestBid = bids[0] ? Number(bids[0].price) : null;
  const bestAsk = asks[0] ? Number(asks[0].price) : null;
  const midPrice =
    bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : mark;

  // Shared live order-management surface: open orders, account-wide marks +
  // funding, realized funding history, the cancel / close / close-all / TP-SL
  // handlers and the assembled tpsl context the BottomPanel consumes. The same
  // hook powers the portfolio's Perps tab. Account state + refreshAccount stay
  // here (read in many places) and are passed in; the selected-market symbol +
  // mark/mid/last overlay keeps the selected row synced with the header.
  const {
    openOrders,
    accountFundings,
    fundingBySymbol,
    markBySymbol,
    tickBySymbol,
    cancelBusy,
    closeAllBusy,
    historyRefreshKey,
    refreshOpenOrders,
    onCancelOrders,
    onClosePosition,
    onCloseAll,
    tpslCtx,
  } = useSodexTradeActions({
    account,
    refreshAccount,
    symbolMeta,
    tm,
    connectedMaster,
    showToast,
    selSymbol: sodexSymbol,
    selMark: mark,
    selMid: midPrice ?? null,
    selLast: lastPrice ?? null,
    fundingTabActive: bottomTab === "Funding",
  });

  // Switch the terminal to a position's market (from the Positions table).
  const onSelectSymbol = useCallback(
    (sym: string) => {
      const a = assets.find(
        (x) => (x.sodex_symbol ?? "").toUpperCase() === sym.toUpperCase(),
      );
      if (a) {
        setAssetId(a.id);
        setSource(undefined); // market switch drops the Event Stream tag
      }
    },
    [assets],
  );

  // Bottom-panel height: load persisted, drag to resize, persist on release.
  const bottomHRef = useRef(DEFAULT_BOTTOM);
  const draggingBottom = useRef(false);
  useEffect(() => {
    try {
      const s = window.localStorage.getItem("helix.terminal.bottomH");
      if (s) {
        const h = clampBottom(Number(s));
        setBottomH(h);
        bottomHRef.current = h;
        setUserDraggedBottom(true); // a saved height is a user choice
      }
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingBottom.current) return;
      const h = clampBottom(window.innerHeight - e.clientY);
      bottomHRef.current = h;
      setBottomH(h);
    };
    const onUp = () => {
      if (!draggingBottom.current) return;
      draggingBottom.current = false;
      setUserDraggedBottom(true); // the dragged height now wins over auto-fit
      document.body.style.userSelect = "";
      try {
        window.localStorage.setItem(
          "helix.terminal.bottomH",
          String(bottomHRef.current),
        );
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);
  const startBottomDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    draggingBottom.current = true;
    document.body.style.userSelect = "none";
  };

  // Auto-fit height for the active tab: header + rows, min ~3 rows, max the cap.
  // Positions/Open Orders fit their row count; the (long) history/funding tabs
  // take the max. Applied only while the user hasn't dragged the divider.
  const activeRowCount =
    bottomTab === "Positions"
      ? (account?.P ?? []).filter((p) => Number(p.sz) !== 0).length
      : bottomTab === "Open Orders"
        ? openOrders.length
        : 999; // Trade/Order History, Closed Positions, Funding → long lists
  const BOTTOM_HEADER_PX = 72;
  const BOTTOM_ROW_PX = 34;
  const fitBottomH = clampBottom(
    BOTTOM_HEADER_PX + Math.max(3, activeRowCount) * BOTTOM_ROW_PX,
  );
  useEffect(() => {
    if (userDraggedBottom) return;
    setBottomH(fitBottomH);
  }, [fitBottomH, userDraggedBottom]);

  const changeAbs = num(ticker?.change);
  const changePct = ticker?.changePct ?? null;
  const up = (changePct ?? 0) >= 0;
  const oiUsd =
    num(ticker?.openInterest) != null && mark != null
      ? (num(ticker?.openInterest) as number) * mark
      : null;
  const fundingPct =
    num(ticker?.fundingRate) != null ? (num(ticker?.fundingRate) as number) * 100 : null;
  const fundingInterval = rules?.fundingInterval ?? 3600;
  const periodsPerYear = (365 * 24 * 3600) / fundingInterval;
  const annualizedFundingPct =
    fundingPct != null ? fundingPct * periodsPerYear : null;
  const countdown =
    ticker?.nextFundingTime != null
      ? Math.max(0, ticker.nextFundingTime - now)
      : null;
  const countdownStr =
    countdown != null
      ? (() => {
          const s = Math.floor(countdown / 1000);
          const h = Math.floor(s / 3600);
          const m = Math.floor((s % 3600) / 60);
          const ss = s % 60;
          return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
        })()
      : null;

  // ── Setup ──
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const levels =
    setup && setup.asset.id === assetId ? setup.setup.key_levels : undefined;

  // Current-symbol position → chart price lines. Entry/liq from the account
  // state; TP/SL from the SAME account-wide open orders the panel reads (the
  // selected symbol's reduce-only stops), classified above/below entry exactly
  // as the Positions SL/TP columns do. Keyed by symbol, so a market switch
  // redraws from live data instead of clearing.
  const chartPosition = useMemo(() => {
    const sym = (sodexSymbol ?? "").toUpperCase();
    const p = account?.P?.find((x) => (x.s ?? "").toUpperCase() === sym);
    if (!p || Number(p.sz) === 0)
      return { entry: null, liq: null, tp: null, sl: null };
    const entry = Number(p.ep) || null;
    const isLong = Number(p.sz) >= 0;
    const stopPx = (o: SodexOpenOrder) =>
      Number((o as { stopPrice?: string }).stopPrice);
    const stops = openOrders.filter((o) => {
      const sp = stopPx(o);
      return (
        (o.symbol ?? "").toUpperCase() === sym &&
        o.reduceOnly &&
        Number.isFinite(sp) &&
        sp > 0
      );
    });
    const tp =
      entry != null
        ? (stops.find((o) => (isLong ? stopPx(o) > entry : stopPx(o) < entry)) ??
          null)
        : null;
    const sl =
      entry != null
        ? (stops.find((o) => (isLong ? stopPx(o) < entry : stopPx(o) > entry)) ??
          null)
        : null;
    return {
      entry,
      liq: p.lp ? Number(p.lp) : null,
      tp: tp ? stopPx(tp) : null,
      sl: sl ? stopPx(sl) : null,
    };
  }, [account, sodexSymbol, openOrders]);
  // Plain (limit) order lines for the SELECTED symbol only. Stops are drawn as
  // TP/SL lines instead, so exclude reduce-only stops and price-less orders.
  const chartOrderLines = useMemo(() => {
    const sym = (sodexSymbol ?? "").toUpperCase();
    return openOrders
      .filter((o) => {
        if ((o.symbol ?? "").toUpperCase() !== sym) return false;
        const sp = Number((o as { stopPrice?: string }).stopPrice);
        if (Number.isFinite(sp) && sp > 0) return false; // a stop → TP/SL line
        const px = Number(o.price);
        return o.price != null && Number.isFinite(px) && px > 0;
      })
      .map((o) => ({
        price: Number(o.price),
        side: (o.side === 1 || o.side === "BUY" ? "buy" : "sell") as
          | "buy"
          | "sell",
        size: o.origQty ?? "",
      }));
  }, [openOrders, sodexSymbol]);

  async function runSetup() {
    if (!assetId) return;
    setSetupLoading(true);
    setSetupError(null);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetId }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? `Setup failed (${res.status})`);
      setSetup(json as SetupResponse);
    } catch (e) {
      setSetupError((e as Error).message);
    } finally {
      setSetupLoading(false);
    }
  }

  return (
    <div className="trade-terminal flex h-full flex-col overflow-hidden rounded-lg border border-line bg-surface">
      {/* ── Header stat row ── */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-7 gap-y-3 border-b border-line bg-surface-2/40 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          {selected ? <AssetLogo symbol={selected.symbol} size={28} /> : null}
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <AssetPicker
                assets={assets}
                value={assetId}
                onChange={(id) => {
                  setAssetId(id);
                  setSetupError(null);
                  setSource(undefined); // market switch drops the Event Stream tag
                }}
                suffix={isPerp ? "-PERP" : "-SPOT"}
              />
            </div>
            <span className="text-[10px] text-fg-dim">{selected?.name}</span>
          </div>
        </div>

        <MarkPrice value={mark} digits={digits} />
        {isPerp ? <Stat label="Oracle" value={fmt(oracle, digits)} /> : null}
        <Stat
          label="24h Change"
          value={
            changeAbs != null
              ? `${changeAbs >= 0 ? "+" : ""}${fmt(changeAbs, digits)} / ${changePct != null ? `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%` : "—"}`
              : "—"
          }
          tone={changePct == null ? "default" : up ? "positive" : "negative"}
        />
        <Stat label="24h Volume" value={fmtUsd(num(ticker?.quoteVolume))} />
        {isPerp ? (
          <>
            <Stat label="Open Interest" value={fmtUsd(oiUsd)} />
            <Stat
              label="Funding"
              value={
                fundingPct != null
                  ? `${fundingPct >= 0 ? "+" : ""}${fundingPct.toFixed(4)}%${countdownStr ? ` · ${countdownStr}` : ""}`
                  : "—"
              }
              tone={fundingPct == null ? "default" : fundingPct >= 0 ? "positive" : "negative"}
              title={
                annualizedFundingPct != null
                  ? `Annualized ≈ ${annualizedFundingPct >= 0 ? "+" : ""}${annualizedFundingPct.toFixed(2)}% (${Math.round(periodsPerYear)}×/yr funding)`
                  : undefined
              }
            />
          </>
        ) : (
          <>
            <Stat label="24h High" value={fmt(num(ticker?.highPx), digits)} />
            <Stat label="24h Low" value={fmt(num(ticker?.lowPx), digits)} />
          </>
        )}

        <button
          onClick={runSetup}
          disabled={setupLoading || !sodexSymbol}
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-[13px] font-medium transition-colors",
            setupLoading
              ? "cursor-wait border-line text-fg-dim"
              : "border-line text-fg-muted hover:border-line-2 hover:text-fg",
          )}
        >
          {setupLoading ? "Reading the tape…" : "⚡ AI Setup"}
        </button>
      </div>

      {/* ── Body: [chart + book] stacked over the bottom tabs on the left,
          with the order ticket as a full-height column on the right (ticket +
          account). The bottom tabs span only the chart + book width. Below lg
          it all stacks and the body scrolls. ── */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        {/* LEFT: chart + book on top, resize handle + bottom tabs below. */}
        <div className="flex min-w-0 flex-col lg:min-h-0 lg:flex-1">
          {/* chart + book */}
          <div className="grid grid-cols-1 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_210px] lg:overflow-hidden">
            {/* Chart cell (relative so the AI-Setup output can float over it).
                min-w-0 lets it shrink so the terminal always fits the viewport. */}
            <div className="relative h-[440px] border-line px-3 py-2 lg:h-auto lg:min-h-0 lg:min-w-0 lg:overflow-hidden lg:border-r">
              {sodexSymbol ? (
                <PriceChart
                  symbol={sodexSymbol}
                  label={`${selected?.symbol ?? ""}-${isPerp ? "PERP" : "SPOT"} · SoDEX`}
                  market={market}
                  levels={levels}
                  tickSize={rules?.tickSize}
                  positionEntry={chartPosition.entry}
                  positionLiq={chartPosition.liq}
                  tpPrice={chartPosition.tp}
                  slPrice={chartPosition.sl}
                  orderLines={chartOrderLines}
                />
              ) : (
                <div className="flex h-full min-h-[360px] items-center justify-center text-sm text-fg-dim">
                  No SoDEX market for this asset.
                </div>
              )}

              {/* AI Setup output floats over the chart; the levels are drawn on
                  the chart itself, so this card is dismissible without them. */}
              {(setup && setup.asset.id === assetId) || setupLoading || setupError ? (
                <div className="absolute bottom-3 left-3 z-20 flex max-h-[72%] w-[min(360px,calc(100%-24px))] flex-col overflow-hidden rounded-lg border border-line bg-surface/95 shadow-2xl backdrop-blur">
                  <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-1.5">
                    <span className="text-[11px] font-medium text-accent-2">AI Setup</span>
                    {!setupLoading ? (
                      <button
                        onClick={() => {
                          setSetup(null);
                          setSetupError(null);
                        }}
                        className="text-[14px] leading-none text-fg-dim hover:text-fg"
                        aria-label="Dismiss setup"
                      >
                        ×
                      </button>
                    ) : null}
                  </div>
                  <div className="min-h-0 overflow-y-auto p-3">
                    {setupError ? (
                      <div className="text-sm text-negative">{setupError}</div>
                    ) : setupLoading ? (
                      <div className="py-4 text-center text-sm text-fg-dim">
                        Pulling {selected?.symbol} news + price, thinking through the setup…
                      </div>
                    ) : setup ? (
                      <SetupCard data={setup} />
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            {/* Order book */}
            <div className="border-t border-line lg:min-h-0 lg:overflow-y-auto lg:border-t-0">
              <OrderBook
                bids={bids}
                asks={asks}
                markPrice={mark}
                loading={mktLoading}
                digits={digits}
                tickSize={rules?.tickSize ?? 0}
                onPriceClick={setLimitFill}
                trades={trades}
                tradesLoading={tradesLoading}
              />
            </div>
          </div>

          {/* Resize handle (desktop) — drag to resize the bottom tabs. */}
          <div
            onMouseDown={startBottomDrag}
            className="group hidden shrink-0 cursor-row-resize items-center justify-center border-t border-line bg-surface-2/20 py-[3px] transition-colors hover:bg-accent/15 lg:flex"
            title="Drag to resize"
            role="separator"
            aria-orientation="horizontal"
          >
            <div className="h-0.5 w-10 rounded-full bg-line-2 group-hover:bg-accent/50" />
          </div>

          {/* Bottom tabs — span only the chart + book width, not the ticket. */}
          <div
            className="shrink-0 overflow-hidden border-t border-line lg:border-t-0"
            style={{ height: bottomH }}
          >
            <BottomPanel
              tab={bottomTab}
              setTab={setBottomTab}
              account={account}
              openOrders={openOrders}
              onCancel={onCancelOrders}
              cancelBusy={cancelBusy}
              onSelectSymbol={onSelectSymbol}
              onClosePosition={onClosePosition}
              onCloseAll={onCloseAll}
              closeAllBusy={closeAllBusy}
              markBySymbol={markBySymbol}
              tickBySymbol={tickBySymbol}
              fundingBySymbol={fundingBySymbol}
              fundingInterval={fundingInterval}
              accountFundings={accountFundings}
              now={now}
              selectedSymbol={sodexSymbol}
              tpsl={tpslCtx}
              ready={tm.ready}
              digits={digits}
              address={tm.address ?? null}
              historyRefreshKey={historyRefreshKey}
            />
          </div>
        </div>

        {/* RIGHT: full-height ticket column — order ticket + account summary. */}
        <div
          id="terminal-ticket"
          className="flex flex-col border-t border-line lg:min-h-0 lg:w-[284px] lg:shrink-0 lg:border-l lg:border-t-0"
        >
          {selected && sodexSymbol ? (
            <OrderPanel
              symbol={selected.symbol}
              sodexSymbol={sodexSymbol}
              market={selected.market}
              markPrice={mark}
              lastPrice={lastPrice}
              midPrice={midPrice}
              rules={rules}
              limitFill={limitFill}
              account={account}
              sideFill={sideFill}
              source={source}
              onSourceConsumed={() => setSource(undefined)}
              onPlaced={() => {
                refreshAccount();
                refreshOpenOrders();
              }}
            />
          ) : null}
          <AccountPanel account={account} ready={tm.ready} />
        </div>
      </div>

      {/* Mobile sticky Buy/Sell bar — jumps to the ticket and sets the side. */}
      <div className="flex shrink-0 gap-2 border-t border-line bg-surface p-2 lg:hidden">
        <button
          onClick={() => onMobileSide("buy")}
          className="flex-1 rounded-md py-2.5 text-[14px] font-semibold text-[#0b0e11]"
          style={{ backgroundColor: "#0ecb81" }}
        >
          Buy / Long
        </button>
        <button
          onClick={() => onMobileSide("sell")}
          className="flex-1 rounded-md py-2.5 text-[14px] font-semibold text-[#0b0e11]"
          style={{ backgroundColor: "#f6465d" }}
        >
          Sell / Short
        </button>
      </div>

      {/* Transient toast — bottom-right raised card, icon + title + detail. */}
      {toast
        ? (() => {
            const kind = toast.startsWith("✓")
              ? "ok"
              : toast.startsWith("✗")
                ? "err"
                : toast.startsWith("⚠")
                  ? "warn"
                  : "info";
            const body = toast.replace(/^[✓✗⚠]\s*/, "");
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
          })()
        : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "default",
  title,
}: {
  label: string;
  value: string;
  tone?: "default" | "positive" | "negative";
  title?: string;
}) {
  return (
    <div className="flex flex-col border-l border-line/70 pl-4" title={title}>
      <span className="text-[11px] uppercase tracking-wide text-fg-dim">
        {label}
      </span>
      <span
        className={cn(
          "font-[var(--font-jetbrains-mono)] text-[13px] leading-tight tabular-nums",
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

/** Mark price with a 150ms green/red background flash on each tick change. */
function MarkPrice({ value, digits }: { value: number | null; digits: number }) {
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const prev = useRef<number | null>(null);
  useEffect(() => {
    if (value == null) return;
    if (prev.current != null && value !== prev.current) {
      setFlash(value > prev.current ? "up" : "down");
      prev.current = value;
      const t = setTimeout(() => setFlash(null), 150);
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);
  return (
    <div className="flex flex-col border-l border-line/70 pl-4">
      <span className="text-[11px] uppercase tracking-wide text-fg-dim">Mark</span>
      <span
        className={cn(
          // The tick flash tints ONLY the background; the number keeps a stable
          // fg colour and weight so it never appears to shift or smear.
          "-ml-1 w-fit rounded px-1 font-[var(--font-jetbrains-mono)] text-[22px] font-semibold leading-tight tabular-nums text-fg transition-colors duration-150 motion-reduce:transition-none",
          flash === "up"
            ? "bg-positive/25"
            : flash === "down"
              ? "bg-negative/25"
              : "bg-transparent",
        )}
      >
        {value != null
          ? value.toLocaleString(undefined, {
              minimumFractionDigits: digits,
              maximumFractionDigits: digits,
            })
          : "—"}
      </span>
    </div>
  );
}
