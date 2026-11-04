"use client";

/**
 * useSodexTradeActions — the terminal's live perps order-management surface,
 * extracted VERBATIM from TradeTerminal so it can be reused by the portfolio's
 * Perps tab. It owns open orders, account-wide marks/funding, realized funding
 * history, the busy flags and the history-refresh key, and exposes the cancel /
 * close / close-all / TP-SL handlers plus the assembled `tpsl` context the
 * BottomPanel consumes.
 *
 * This is a pure relocation: the handlers build and submit orders with the
 * EXACT same arguments as before through the unchanged placeLiveOrder /
 * placeTriggerForPosition / cancelOrders paths — so the signed payloads are
 * byte-identical. Account state + refreshAccount stay with the parent (it reads
 * them in many places) and are passed in; the selected-market context is
 * optional (the terminal passes its symbol/mark/mid/last; the portfolio passes
 * nulls).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
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
import type {
  SodexPerpsAccountState,
  SodexOpenOrder,
  SodexFundingPayment,
} from "@/lib/sodex-onchain/types";

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

// TP/SL placement. The earlier P0 (orders accepted by the POST but never
// resting on SoDEX) is addressed: every order flow now classifies the per-order
// result (classifyOrderResult), a rejected order throws with SoDEX's reason, and
// a modify re-fetches the open-orders endpoint to confirm the NEW trigger rests
// before cancelling the OLD one — so the position is never left unprotected.
const TPSL_PLACEMENT_ENABLED = true;

export interface UseSodexTradeActionsArgs {
  /** Live perps account state — polled by the PARENT (read in many places). */
  account: SodexPerpsAccountState | null;
  /** Re-sync the account immediately after an order action. */
  refreshAccount: () => void;
  /** Per-symbol metadata keyed by sodex symbol. */
  symbolMeta: Record<string, SymbolMeta>;
  /** Trade-mode readiness + master/account address. */
  tm: { ready: boolean; address: `0x${string}` | null };
  /** Connected master wallet (wagmi) — resolves the account for order signing. */
  connectedMaster: `0x${string}` | undefined;
  showToast: (msg: string) => void;
  /** Selected-market context (terminal). The portfolio passes nulls. */
  selSymbol?: string | null;
  selMark?: number | null;
  selMid?: number | null;
  selLast?: number | null;
  /** True while the Funding tab is visible (gates the fundings fetch). */
  fundingTabActive?: boolean;
}

export function useSodexTradeActions({
  account,
  refreshAccount,
  symbolMeta,
  tm,
  connectedMaster,
  showToast,
  selSymbol = null,
  selMark = null,
  selMid = null,
  selLast = null,
  fundingTabActive = false,
}: UseSodexTradeActionsArgs) {
  const router = useRouter();
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
    if (!fundingTabActive || !tm.ready || !tm.address) return;
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
  }, [fundingTabActive, tm.ready, tm.address]);

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

  // Live mark per symbol for the Positions table: start from the all-symbols
  // perps ticker poll (covers every open position), then overlay the selected
  // market's live mark so its row stays exactly in sync with the header. A
  // symbol with no ticker yet resolves to "—" downstream — never a derived value.
  const markBySymbol = useMemo<Record<string, number>>(() => {
    const m: Record<string, number> = { ...allMarks };
    if (selSymbol && selMark != null) m[selSymbol.toUpperCase()] = selMark;
    return m;
  }, [allMarks, selSymbol, selMark]);

  // Tick size per symbol (keyed like symbolMeta) so every table/history row
  // prices to ITS OWN symbol's tick, not the selected market's.
  const tickBySymbol = useMemo<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    for (const [sym, meta] of Object.entries(symbolMeta)) m[sym] = meta.tickSize;
    return m;
  }, [symbolMeta]);

  // Close (or partially close) a position from the Close modal: a reduce-only
  // order on the opposite side, through the existing placeLiveOrder path (no
  // signing change). Size is in base units; we pass the USD notional the path
  // expects (base × price). Result is surfaced as a toast, positions re-synced.
  const onClosePosition = useCallback(
    async (
      pos: SodexPerpsAccountState["P"][number],
      opts: { sizeBase: number; type: "market" | "limit"; limitPrice?: number },
    ): Promise<{ ok: boolean; error?: string }> => {
      const key = readLocalKey("mainnet");
      if (!key) {
        showToast("Connect a SoDEX key first.");
        return { ok: false, error: "Connect a SoDEX key first." };
      }
      const sz = Number(pos.sz);
      if (!sz || !(opts.sizeBase > 0)) {
        return { ok: false, error: "Nothing to close." };
      }
      const mk = markBySymbol[pos.s.toUpperCase()] ?? Number(pos.ep);
      const px =
        opts.type === "limit" && opts.limitPrice ? opts.limitPrice : mk;
      let resultMsg: string | null = null;
      await placeLiveOrder({
        network: "mainnet",
        signal: {
          signal_id: `close-${pos.s}-${Date.now().toString(36)}`,
          symbol: pos.s,
          side: sz > 0 ? "sell" : "buy", // opposite side closes
          price_usd: px,
        },
        identityAddress: key.address ?? null,
        connectedMaster,
        sizeInput: String(opts.sizeBase * px),
        stopInput: "",
        targetInput: "",
        orderType: opts.type === "limit" ? "LIMIT" : "MARKET",
        limitPrice: opts.type === "limit" ? opts.limitPrice : undefined,
        timeInForce: opts.type === "limit" ? "GTC" : undefined,
        reduceOnly: true,
        setMsg: (m) => {
          resultMsg = m;
        },
        setBusy: () => {},
        setConfirming: () => {},
      });
      refreshAccount();
      refreshOpenOrders();
      bumpHistory();
      if (resultMsg) showToast(resultMsg);
      const ok = !resultMsg || !(resultMsg as string).startsWith("✗");
      return { ok, error: ok ? undefined : (resultMsg ?? "Close failed.") };
    },
    [
      markBySymbol,
      connectedMaster,
      refreshAccount,
      refreshOpenOrders,
      bumpHistory,
      showToast,
    ],
  );

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
      selSymbol: selSymbol ?? null,
      selMid: selMid ?? null,
      selLast: selLast ?? null,
      builderRate,
      busy: tpslBusy,
      placementEnabled: TPSL_PLACEMENT_ENABLED,
      onSet: onSetTpSl,
      onRemove: onRemoveTrigger,
    }),
    [
      symbolMeta,
      markBySymbol,
      selSymbol,
      selMid,
      selLast,
      builderRate,
      tpslBusy,
      onSetTpSl,
      onRemoveTrigger,
    ],
  );

  return {
    openOrders,
    accountFundings,
    fundingBySymbol,
    markBySymbol,
    tickBySymbol,
    builderRate,
    cancelBusy,
    closeAllBusy,
    tpslBusy,
    historyRefreshKey,
    bumpHistory,
    refreshOpenOrders,
    onCancelOrders,
    onClosePosition,
    onCloseAll,
    verifyOrderGone,
    onSetTpSl,
    onRemoveTrigger,
    tpslCtx,
  };
}
