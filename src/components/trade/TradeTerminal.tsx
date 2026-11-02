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
import { AssetPicker } from "./AssetPicker";
import { SetupCard, type SetupResponse } from "./SetupCard";
import { PriceChart } from "./PriceChart";
import { OrderBook, type BookLevel } from "./OrderBook";
import { OrderPanel, type SymbolRules } from "./OrderPanel";
import type { Trade } from "./TradesTape";
import { BottomPanel, type BottomTab } from "./BottomPanel";
import { useTradeMode } from "@/lib/sodex-onchain/useTradeMode";
import {
  getPerpsAccountState,
  getOpenOrders,
  cancelOrders,
} from "@/lib/sodex-onchain/client";
import { readLocalKey } from "@/lib/sodex-onchain/local-keys";
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

export function TradeTerminal({ assets }: { assets: TerminalAsset[] }) {
  const tm = useTradeMode("mainnet");
  const [assetId, setAssetId] = useState<string>(
    () => assets.find((a) => a.id === "tok-btc")?.id ?? assets[0]?.id ?? "",
  );
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
  const [account, setAccount] = useState<SodexPerpsAccountState | null>(null);
  const [openOrders, setOpenOrders] = useState<SodexOpenOrder[]>([]);
  // Live mark per symbol across ALL open positions (not just the selected
  // market), from the all-tickers poll below.
  const [allMarks, setAllMarks] = useState<Record<string, number>>({});
  const [cancelBusy, setCancelBusy] = useState(false);
  const [bottomH, setBottomH] = useState(DEFAULT_BOTTOM);
  const [sideFill, setSideFill] = useState<{
    side: "buy" | "sell";
    seq: number;
  } | null>(null);
  const onMobileSide = (side: "buy" | "sell") => {
    setSideFill((p) => ({ side, seq: (p?.seq ?? 0) + 1 }));
    document
      .getElementById("terminal-ticket")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  // Close-position intent handed to the order ticket (opposite side, full size,
  // reduce-only). Market opens the inline confirm; limit just prefills.
  const [closeIntent, setCloseIntent] = useState<{
    side: "buy" | "sell";
    sizeBase: number;
    type: "market" | "limit";
    seq: number;
  } | null>(null);

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

  // Marks for EVERY open position's symbol, so positions on markets other than
  // the selected one still show a live mark (and liq warning) instead of "—".
  // SoDEX /markets/tickers returns all symbols in one request; poll it at the
  // selected ticker's cadence, and only while there are open positions.
  const hasOpenPositions = (account?.P ?? []).some((p) => Number(p.sz) !== 0);
  useEffect(() => {
    if (!hasOpenPositions) {
      setAllMarks({});
      return;
    }
    let cancelled = false;
    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const r = await fetch(`/api/sodex/tickers?market=perp`);
        const j = await r.json();
        if (cancelled || !j.ok) return;
        setAllMarks(j.marks ?? {});
      } catch {
        /* keep last good marks */
      }
    };
    load();
    const t = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [hasOpenPositions]);

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
  useEffect(() => {
    if (!tm.ready || !tm.address) {
      setAccount(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const st = await getPerpsAccountState(
          "mainnet",
          tm.address as `0x${string}`,
        );
        if (!cancelled) setAccount(st);
      } catch {
        /* keep last good */
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [tm.ready, tm.address]);

  // Open orders for the CURRENT symbol (read-only, polled). Scoping to the
  // symbol keeps "Cancel all" per-symbol.
  const refreshOpenOrders = useCallback(async () => {
    if (!tm.ready || !tm.address) {
      setOpenOrders([]);
      return;
    }
    try {
      const all = await getOpenOrders("mainnet", tm.address as `0x${string}`);
      const sym = (sodexSymbol ?? "").toUpperCase();
      setOpenOrders(all.filter((o) => (o.symbol ?? "").toUpperCase() === sym));
    } catch {
      /* keep last */
    }
  }, [tm.ready, tm.address, sodexSymbol]);
  useEffect(() => {
    refreshOpenOrders();
    const t = setInterval(refreshOpenOrders, 4000);
    return () => clearInterval(t);
  }, [refreshOpenOrders]);

  // Cancel orders by id (per-row or cancel-all), then refresh. Signs with the
  // local API key; symbolID comes from the current market's rules.
  const onCancelOrders = useCallback(
    async (orderIDs: number[]) => {
      const key = readLocalKey("mainnet");
      if (!key || !account?.aid || !rules?.id || orderIDs.length === 0) return;
      setCancelBusy(true);
      try {
        await cancelOrders({
          network: "mainnet",
          apiKeyName: key.name || undefined,
          privateKey: key.privateKey,
          accountID: account.aid,
          cancels: orderIDs.map((orderID) => ({ symbolID: rules.id, orderID })),
        });
        await refreshOpenOrders();
      } catch (e) {
        console.warn("[cancel] failed:", (e as Error).message);
      } finally {
        setCancelBusy(false);
      }
    },
    [account?.aid, rules?.id, refreshOpenOrders],
  );

  // Switch the terminal to a position's market (from the Positions table).
  const onSelectSymbol = useCallback(
    (sym: string) => {
      const a = assets.find(
        (x) => (x.sodex_symbol ?? "").toUpperCase() === sym.toUpperCase(),
      );
      if (a) setAssetId(a.id);
    },
    [assets],
  );

  // Close a position through the ticket: opposite side, full size, reduce-only.
  const onClosePosition = useCallback(
    (pos: SodexPerpsAccountState["P"][number], type: "market" | "limit") => {
      const sz = Number(pos.sz);
      if (!sz) return;
      onSelectSymbol(pos.s); // move the ticket to the position's market first
      setCloseIntent((prev) => ({
        side: sz > 0 ? "sell" : "buy", // opposite side closes
        sizeBase: Math.abs(sz),
        type,
        seq: (prev?.seq ?? 0) + 1,
      }));
    },
    [onSelectSymbol],
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

  // Mark = perp mark price, else last. Everything anchors to this.
  const mark = num(ticker?.markPrice) ?? num(ticker?.lastPx);
  const digits = mark != null && mark < 10 ? 4 : 2;

  // Live mark per symbol for the Positions table: start from the all-symbols
  // perps ticker poll (covers every open position), then overlay the selected
  // market's live mark so its row stays exactly in sync with the header. A
  // symbol with no ticker yet resolves to "—" downstream — never a derived value.
  const markBySymbol = useMemo<Record<string, number>>(() => {
    const m: Record<string, number> = { ...allMarks };
    if (sodexSymbol && mark != null) m[sodexSymbol.toUpperCase()] = mark;
    return m;
  }, [allMarks, sodexSymbol, mark]);
  const oracle = num(ticker?.indexPrice);
  const lastPrice = num(ticker?.lastPx);
  const bestBid = bids[0] ? Number(bids[0].price) : null;
  const bestAsk = asks[0] ? Number(asks[0].price) : null;
  const midPrice =
    bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : mark;
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

  // Current-symbol position (entry/liq) + open orders → chart price lines.
  const chartPosition = useMemo(() => {
    const p = account?.P?.find(
      (x) => (x.s ?? "").toUpperCase() === (sodexSymbol ?? "").toUpperCase(),
    );
    if (!p || Number(p.sz) === 0) return { entry: null, liq: null };
    return {
      entry: Number(p.ep) || null,
      liq: p.lp ? Number(p.lp) : null,
    };
  }, [account, sodexSymbol]);
  const chartOrderLines = useMemo(
    () =>
      openOrders
        .filter((o) => o.price != null && Number.isFinite(Number(o.price)))
        .map((o) => ({
          price: Number(o.price),
          side: (o.side === 1 ? "buy" : "sell") as "buy" | "sell", // 1 = BUY
          size: o.origQty ?? "",
        })),
    [openOrders],
  );

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

      {/* ── Body: chart | book | ticket. Fills the remaining height; each
          panel scrolls internally on desktop. Below lg it stacks (chart →
          form → book) and the body scrolls. ── */}
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_210px_284px] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
        {/* Chart cell (relative so the AI-Setup output can float over it).
            Fixed height on mobile (grid rows are auto there); from lg it
            stretches to the single 1fr row and the chart fills it. */}
        <div className="relative order-1 h-[440px] border-line px-3 py-2 lg:h-auto lg:min-h-0 lg:overflow-hidden lg:border-r">
          {sodexSymbol ? (
            <PriceChart
              symbol={sodexSymbol}
              label={`${selected?.symbol ?? ""}-${isPerp ? "PERP" : "SPOT"} · SoDEX`}
              market={market}
              levels={levels}
              tickSize={rules?.tickSize}
              positionEntry={chartPosition.entry}
              positionLiq={chartPosition.liq}
              orderLines={chartOrderLines}
            />
          ) : (
            <div className="flex h-full min-h-[360px] items-center justify-center text-sm text-fg-dim">
              No SoDEX market for this asset.
            </div>
          )}

          {/* AI Setup output floats over the chart; the levels are drawn on
              the chart itself, so this card is dismissible without losing them. */}
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
        <div className="order-3 border-t border-line lg:order-2 lg:min-h-0 lg:overflow-y-auto lg:border-t-0">
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

        {/* Order ticket */}
        <div
          id="terminal-ticket"
          className="order-2 border-t border-line lg:order-3 lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-t-0"
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
              closeIntent={closeIntent}
            />
          ) : null}
        </div>
      </div>

      {/* ── Resize handle + bottom panel ── */}
      <div
        onMouseDown={startBottomDrag}
        className="group hidden shrink-0 cursor-row-resize items-center justify-center border-t border-line bg-surface-2/20 py-[3px] transition-colors hover:bg-accent/15 lg:flex"
        title="Drag to resize"
        role="separator"
        aria-orientation="horizontal"
      >
        <div className="h-0.5 w-10 rounded-full bg-line-2 group-hover:bg-accent/50" />
      </div>
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
          markBySymbol={markBySymbol}
          ready={tm.ready}
          digits={digits}
        />
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
    <div className="flex flex-col" title={title}>
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
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wide text-fg-dim">Mark</span>
      <span
        className={cn(
          "w-fit rounded px-1 font-[var(--font-jetbrains-mono)] text-[21px] font-semibold leading-tight tabular-nums transition-colors duration-150 motion-reduce:transition-none",
          flash === "up"
            ? "bg-positive/25 text-positive"
            : flash === "down"
              ? "bg-negative/25 text-negative"
              : "bg-transparent text-fg",
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
