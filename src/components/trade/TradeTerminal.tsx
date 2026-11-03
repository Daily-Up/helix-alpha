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
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui/cn";
import { AssetLogo } from "@/components/ui/AssetLogo";
import { AssetPicker } from "./AssetPicker";
import { SetupCard, type SetupResponse } from "./SetupCard";
import { PriceChart } from "./PriceChart";
import { OrderBook, type BookLevel } from "./OrderBook";
import { OrderPanel, type SymbolRules } from "./OrderPanel";
import { AccountPanel } from "./AccountPanel";
import type { Trade } from "./TradesTape";
import { BottomPanel, type BottomTab } from "./BottomPanel";
import { useTradeMode } from "@/lib/sodex-onchain/useTradeMode";
import {
  getPerpsAccountState,
  getOpenOrders,
  getAccountFundings,
  cancelOrders,
} from "@/lib/sodex-onchain/client";
import { readLocalKey } from "@/lib/sodex-onchain/local-keys";
import {
  placeLiveOrder,
  placeTriggerForPosition,
} from "@/lib/sodex-onchain/placeLiveOrder";
import { getBuilderCode } from "@/lib/sodex-onchain/chains";
import { useAccount } from "wagmi";
import type {
  SodexPerpsAccountState,
  SodexOpenOrder,
  SodexFundingPayment,
} from "@/lib/sodex-onchain/types";

export interface TerminalAsset {
  id: string;
  symbol: string;
  name: string;
  kind: string;
  sodex_symbol: string | null;
  market: "spot" | "perp" | null;
}

/** Static per-symbol metadata from /markets/symbols (tick/step/fee/ID), keyed
 *  by sodex symbol — lets TP/SL work for any open position, not just the
 *  selected market. */
export interface SymbolMeta {
  symbolID: number;
  tickSize: number;
  stepSize: number;
  pricePrecision: number;
  quantityPrecision: number;
  takerFee: number;
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

// TP/SL placement. The earlier P0 (orders accepted by the POST but never
// resting on SoDEX) is addressed: every order flow now classifies the per-order
// result (classifyOrderResult), a rejected order throws with SoDEX's reason, and
// a modify re-fetches the open-orders endpoint to confirm the NEW trigger rests
// before cancelling the OLD one — so the position is never left unprotected.
const TPSL_PLACEMENT_ENABLED = true;

const MIN_BOTTOM = 120;
const DEFAULT_BOTTOM = 220;
const clampBottom = (h: number) => {
  const vh = typeof window !== "undefined" ? window.innerHeight : 900;
  return Math.max(MIN_BOTTOM, Math.min(h, vh * 0.5));
};

export function TradeTerminal({
  assets,
  symbolMeta = {},
}: {
  assets: TerminalAsset[];
  symbolMeta?: Record<string, SymbolMeta>;
}) {
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
  // Realized funding payments for the Funding tab (most-recent first). Fetched
  // lazily — only while that tab is open — and refreshed on a slow interval.
  const [accountFundings, setAccountFundings] = useState<SodexFundingPayment[]>(
    [],
  );
  // Live mark per symbol across ALL open positions (not just the selected
  // market), from the all-tickers poll below.
  const [allMarks, setAllMarks] = useState<Record<string, number>>({});
  // Per-symbol funding (raw rate + next funding time, ms) from the same poll,
  // so the Positions "Funding" column + Funding tab are account-wide.
  const [fundingBySymbol, setFundingBySymbol] = useState<
    Record<string, { rate: number; next: number }>
  >({});
  const [cancelBusy, setCancelBusy] = useState(false);
  const [closeAllBusy, setCloseAllBusy] = useState(false);
  const [tpslBusy, setTpslBusy] = useState(false);
  // Bumped after any order action so open history tabs refetch.
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const bumpHistory = useCallback(() => setHistoryRefreshKey((k) => k + 1), []);
  const { address: connectedMaster } = useAccount();
  const router = useRouter();

  // Transient terminal toast (errors like an un-resolvable cancel). Auto-clears.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
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
      setFundingBySymbol({});
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
        setFundingBySymbol(j.funding ?? {});
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

  // Open orders ACCOUNT-WIDE (every symbol), read-only, polled on the account
  // interval. The bottom panel + chart key these by symbol, so switching
  // markets never clears another market's TP/SL or open orders. "Current
  // market only" (in the panel) is the sole per-symbol filter.
  const refreshOpenOrders = useCallback(async () => {
    if (!tm.ready || !tm.address) {
      setOpenOrders([]);
      return;
    }
    try {
      const all = await getOpenOrders("mainnet", tm.address as `0x${string}`);
      setOpenOrders(all);
    } catch {
      /* keep last */
    }
  }, [tm.ready, tm.address]);
  useEffect(() => {
    refreshOpenOrders();
    const t = setInterval(refreshOpenOrders, 5000);
    return () => clearInterval(t);
  }, [refreshOpenOrders]);

  // Realized funding history — fetched only while the Funding tab is open
  // (funding settles hourly, so a slow 60s refresh is plenty).
  useEffect(() => {
    if (bottomTab !== "Funding" || !tm.ready || !tm.address) return;
    let cancelled = false;
    const load = async () => {
      try {
        const rows = await getAccountFundings(
          "mainnet",
          tm.address as `0x${string}`,
          { limit: 100 },
        );
        if (!cancelled) setAccountFundings(rows);
      } catch {
        /* keep last good */
      }
    };
    load();
    const t = setInterval(load, 60000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [bottomTab, tm.ready, tm.address]);

  // Cancel orders (per-row or cancel-all), then refresh. Signs with the local
  // API key. Orders can span multiple markets (account-wide fetch), so each
  // cancel must carry its OWN symbolID, resolved from the order's symbol via
  // symbolMeta. There is NO fallback to the selected market's id: signing a
  // cancel under the wrong market is exactly the bug this guards against. If a
  // symbolID can't be resolved, cancel nothing, tell the user, and refresh
  // symbolMeta so a retry a moment later succeeds.
  const onCancelOrders = useCallback(
    async (orders: SodexOpenOrder[]) => {
      const key = readLocalKey("mainnet");
      if (!key || !account?.aid || orders.length === 0) return;
      const resolved = orders.map((o) => ({
        o,
        symbolID: symbolMeta[(o.symbol ?? "").toUpperCase()]?.symbolID,
      }));
      const missing = resolved.filter((r) => r.symbolID == null);
      if (missing.length > 0) {
        const names = [
          ...new Set(
            missing.map((r) => (r.o.symbol ?? "?").replace(/-USDC?$/i, "-PERP")),
          ),
        ].join(", ");
        showToast(
          `Can't cancel: market data for ${names} not loaded, retry in a moment`,
        );
        router.refresh(); // re-pull symbolMeta (server-provided) and retry
        return;
      }
      const cancels = resolved.map((r) => ({
        symbolID: r.symbolID as number,
        orderID: r.o.orderID,
      }));
      setCancelBusy(true);
      try {
        await cancelOrders({
          network: "mainnet",
          apiKeyName: key.name || undefined,
          privateKey: key.privateKey,
          accountID: account.aid,
          cancels,
        });
        await refreshOpenOrders();
        bumpHistory();
      } catch (e) {
        showToast(`Cancel failed: ${(e as Error).message}`);
        console.warn("[cancel] failed:", (e as Error).message);
      } finally {
        setCancelBusy(false);
      }
    },
    [account?.aid, symbolMeta, refreshOpenOrders, router, showToast, bumpHistory],
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

  // Tick size per symbol (keyed like symbolMeta) so every table/history row
  // prices to ITS OWN symbol's tick, not the selected market's.
  const tickBySymbol = useMemo<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    for (const [sym, meta] of Object.entries(symbolMeta)) m[sym] = meta.tickSize;
    return m;
  }, [symbolMeta]);

  // Close ALL positions — a market reduce-only close for each, through the same
  // live path as a single close (no signing changes). The local API key signs;
  // connectedMaster resolves the account. Batch-level busy flag; the account +
  // open-orders polls refresh the panel as positions close.
  const onCloseAll = useCallback(
    async (toClose: SodexPerpsAccountState["P"]) => {
      if (closeAllBusy) return;
      const list = (toClose ?? []).filter((p) => Number(p.sz) !== 0);
      if (!list.length) return;
      setCloseAllBusy(true);
      try {
        for (const p of list) {
          const sz = Number(p.sz);
          const mk = markBySymbol[p.s.toUpperCase()] ?? Number(p.ep);
          const notional = Math.abs(sz) * mk;
          if (!Number.isFinite(notional) || notional <= 0) continue;
          await placeLiveOrder({
            network: "mainnet",
            signal: {
              signal_id: `closeall-${p.s}-${Date.now().toString(36)}`,
              symbol: p.s,
              side: sz > 0 ? "sell" : "buy", // opposite side closes
              price_usd: mk,
            },
            identityAddress: readLocalKey("mainnet")?.address ?? null,
            connectedMaster,
            sizeInput: String(notional),
            stopInput: "",
            targetInput: "",
            orderType: "MARKET",
            reduceOnly: true,
            setMsg: () => {},
            setBusy: () => {},
            setConfirming: () => {},
            setTradesToday: () => {},
          });
        }
      } finally {
        setCloseAllBusy(false);
        refreshOpenOrders();
        bumpHistory();
      }
    },
    [closeAllBusy, markBySymbol, connectedMaster, refreshOpenOrders, bumpHistory],
  );

  const builderRate = useMemo(() => {
    const b = getBuilderCode("mainnet");
    return b ? b.fee / 100_000 : 0;
  }, []);

  // Confirm an order is no longer resting on SoDEX — the only proof a cancel
  // took (a 200 is not). Poll open orders up to ~5s (every 1s). Shared by the
  // modal's per-leg cancel and the positions table's per-row ×.
  const verifyOrderGone = useCallback(
    async (orderID: number): Promise<boolean> => {
      for (let i = 0; i < 5; i++) {
        try {
          const open = await getOpenOrders(
            "mainnet",
            tm.address as `0x${string}`,
          );
          if (!open.some((o) => o.orderID === orderID)) return true;
        } catch {
          /* retry */
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return false;
    },
    [tm.address],
  );

  // Set / modify / cancel TP & SL for an open position (selected market only —
  // its rules carry the symbolID + tick/step). Per leg: a number places the NEW
  // trigger first then cancels the OLD on success; "cancel" cancels the resting
  // trigger (verified gone); null leaves the leg untouched.
  const onSetTpSl = useCallback(
    async (
      pos: SodexPerpsAccountState["P"][number],
      next: {
        tp: number | "cancel" | null;
        sl: number | "cancel" | null;
      },
      existing: { tpOrderId: number | null; slOrderId: number | null },
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!TPSL_PLACEMENT_ENABLED) {
        return {
          ok: false,
          error: "TP/SL placement is being fixed — temporarily disabled.",
        };
      }
      const key = readLocalKey("mainnet");
      const aid = account?.aid;
      const meta = symbolMeta[(pos.s ?? "").toUpperCase()];
      if (!key || aid == null || !meta) {
        return {
          ok: false,
          error: meta
            ? "Connect a SoDEX key first."
            : "No market metadata for this symbol.",
        };
      }
      const isLong = Number(pos.sz) >= 0;
      const qty = Math.abs(Number(pos.sz)).toFixed(meta.quantityPrecision);
      const pxDp = meta.pricePrecision;
      const tick = meta.tickSize > 0 ? meta.tickSize : 0;
      const roundTick = (p: number) =>
        tick > 0 ? (Math.round(p / tick) * tick).toFixed(pxDp) : p.toFixed(pxDp);
      // Place NEW, then cancel OLD on success — never cancel first.
      const replace = async (
        intent: number | "cancel" | null,
        stopType: number,
        oldId: number | null,
      ): Promise<string | null> => {
        if (intent == null) return null; // this leg unchanged
        const leg = stopType === 2 ? "take-profit" : "stop-loss";
        const legShort = stopType === 2 ? "TP" : "SL";
        // Cancel this leg's resting trigger, then confirm it actually left the
        // book (a 200 is not proof). On timeout, surface it — don't claim done.
        if (intent === "cancel") {
          if (oldId == null) return null; // nothing resting to cancel
          try {
            await cancelOrders({
              network: "mainnet",
              apiKeyName: key.name || undefined,
              privateKey: key.privateKey,
              accountID: aid,
              cancels: [{ symbolID: meta.symbolID, orderID: oldId }],
            });
          } catch (e) {
            return `${legShort} cancel: ${(e as Error).message}`;
          }
          if (!(await verifyOrderGone(oldId))) {
            return `${legShort} still resting — cancel not confirmed`;
          }
          return null;
        }
        let clOrdID: string;
        try {
          ({ clOrdID } = await placeTriggerForPosition({
            network: "mainnet",
            apiKeyName: key.name || undefined,
            privateKey: key.privateKey,
            accountID: aid,
            symbolID: meta.symbolID,
            positionIsLong: isLong,
            quantity: qty,
            stopPrice: roundTick(intent),
            stopType,
          }));
        } catch (e) {
          return `${leg}: ${(e as Error).message}`; // rejected — keep the old order
        }
        // SoDEX's open-orders endpoint is the only source of truth: a POST can
        // 200 while the order is rejected per-order. Confirm the new order
        // actually rests BEFORE cancelling the old one (the P0: a false success
        // used to cancel the old order and leave the position unprotected).
        // Poll up to ~5s (every 1s); if the new order never shows, keep the old
        // one untouched — never cancel the old without seeing the new.
        let landed = false;
        for (let i = 0; i < 5 && !landed; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const open = await getOpenOrders(
              "mainnet",
              tm.address as `0x${string}`,
            );
            landed = open.some((o) => o.clOrdID === clOrdID);
          } catch {
            /* retry */
          }
        }
        if (!landed) {
          return `New ${legShort} not confirmed yet; old one kept`;
        }
        if (oldId != null) {
          try {
            await cancelOrders({
              network: "mainnet",
              apiKeyName: key.name || undefined,
              privateKey: key.privateKey,
              accountID: aid,
              cancels: [{ symbolID: meta.symbolID, orderID: oldId }],
            });
          } catch {
            /* new order is confirmed live; a stale old order is non-fatal */
          }
        }
        return null;
      };
      setTpslBusy(true);
      try {
        const errs = (
          [
            await replace(next.tp, 2, existing.tpOrderId),
            await replace(next.sl, 1, existing.slOrderId),
          ] as (string | null)[]
        ).filter((e): e is string => e != null);
        await refreshOpenOrders();
        return errs.length ? { ok: false, error: errs.join("; ") } : { ok: true };
      } finally {
        setTpslBusy(false);
      }
    },
    [account?.aid, tm.address, symbolMeta, refreshOpenOrders, verifyOrderGone],
  );

  // Cancel one resting trigger order directly (the positions table's per-row ×).
  // Verifies the order actually left the book and toasts on failure — the table
  // has no inline error line of its own. Not gated by the placement flag.
  const onRemoveTrigger = useCallback(
    async (
      pos: SodexPerpsAccountState["P"][number],
      orderID: number,
    ): Promise<{ ok: boolean; error?: string }> => {
      const key = readLocalKey("mainnet");
      const aid = account?.aid;
      const meta = symbolMeta[(pos.s ?? "").toUpperCase()];
      if (!key || aid == null || !meta) {
        const error = "Connect a SoDEX key first.";
        showToast(error);
        return { ok: false, error };
      }
      setTpslBusy(true);
      try {
        await cancelOrders({
          network: "mainnet",
          apiKeyName: key.name || undefined,
          privateKey: key.privateKey,
          accountID: aid,
          cancels: [{ symbolID: meta.symbolID, orderID }],
        });
        const gone = await verifyOrderGone(orderID);
        await refreshOpenOrders();
        if (!gone) {
          const error = "Cancel not confirmed — the order still shows on SoDEX.";
          showToast(error);
          return { ok: false, error };
        }
        return { ok: true };
      } catch (e) {
        const error = (e as Error).message;
        showToast(`Cancel failed: ${error}`);
        return { ok: false, error };
      } finally {
        setTpslBusy(false);
      }
    },
    [account?.aid, symbolMeta, refreshOpenOrders, verifyOrderGone, showToast],
  );

  const tpslCtx = useMemo(
    () => ({
      meta: symbolMeta,
      markBySymbol,
      builderRate,
      busy: tpslBusy,
      placementEnabled: TPSL_PLACEMENT_ENABLED,
      onSet: onSetTpSl,
      onRemove: onRemoveTrigger,
    }),
    [symbolMeta, markBySymbol, builderRate, tpslBusy, onSetTpSl, onRemoveTrigger],
  );
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
              closeIntent={closeIntent}
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

      {/* Transient error toast (e.g. a cancel whose market data isn't loaded). */}
      {toast ? (
        <div
          role="status"
          className="pointer-events-none fixed bottom-6 left-1/2 z-[100] max-w-[90vw] -translate-x-1/2 rounded-md border border-negative/50 bg-surface px-4 py-2.5 text-center text-[12.5px] text-fg shadow-2xl"
        >
          {toast}
        </div>
      ) : null}
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
