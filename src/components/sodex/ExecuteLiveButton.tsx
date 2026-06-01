"use client";

/**
 * Single-click live-execution button for a signal.
 *
 * Renders ONLY when the user has:
 *   1. Connected a wallet (via wagmi)
 *   2. Generated a Helix API key for the active network
 *   3. Accepted the safety-limits disclaimer
 *
 * Click flow:
 *   browser → builds order params → signs with API key → POSTs to
 *   SoDEX gateway DIRECTLY → on response, posts the public outcome
 *   to /api/sodex/record-trade for the audit log.
 *
 * Helix's server is NEVER on the critical path of the trade — only
 * the after-the-fact audit log.
 */

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  DEFAULT_NETWORK,
  NETWORK_STORAGE_KEY,
  SODEX_NETWORKS,
  type SodexNetwork,
} from "@/lib/sodex-onchain/chains";
import {
  placeOrderBatch,
  getAccountState,
  getSymbolId,
} from "@/lib/sodex-onchain/client";
import {
  readLocalKey,
  readSafetyLimits,
} from "@/lib/sodex-onchain/local-keys";
import {
  SodexOrderType,
  SodexSide,
  SodexTimeInForce,
  type SodexNewOrderEntry,
} from "@/lib/sodex-onchain/types";
import { cn } from "@/components/ui/cn";

export interface ExecuteLiveSignal {
  signal_id: string;
  /** SoDEX textual symbol like "BTC-USDC". */
  symbol: string;
  /** Optional SoDEX numeric symbolID — resolved at runtime if absent. */
  symbol_id?: number;
  side: "buy" | "sell";
  /** Suggested size in USD (clamped to user's per-trade max). */
  suggested_size_usd: number;
  /** Current market price used for the optimistic display. */
  price_usd: number;
}

interface Props {
  signal: ExecuteLiveSignal;
}

export function ExecuteLiveButton({ signal }: Props) {
  const { address, isConnected } = useAccount();
  const [network, setNetwork] = useState<SodexNetwork>(DEFAULT_NETWORK);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(NETWORK_STORAGE_KEY);
    if (stored === "mainnet" || stored === "testnet") setNetwork(stored);
  }, []);

  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!isConnected || !address) {
      setReady(false);
      return;
    }
    const key = readLocalKey(network, address);
    const limits = readSafetyLimits(address);
    setReady(!!key && limits.acceptedDisclaimer);
  }, [isConnected, address, network]);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const onClick = useCallback(async () => {
    if (!address) return;
    const key = readLocalKey(network, address);
    if (!key) {
      setMsg("Generate an API key on /settings/connect-sodex first.");
      return;
    }
    const limits = readSafetyLimits(address);
    const sizeUsd = Math.min(signal.suggested_size_usd, limits.maxPositionUsd);
    if (sizeUsd <= 0) {
      setMsg("Position size cap is 0 — edit your safety limits.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const state = await getAccountState(network, address);
      let symbolId = signal.symbol_id;
      if (symbolId == null) {
        symbolId = await getSymbolId(network, signal.symbol);
      }
      if (symbolId == null) {
        throw new Error(
          `Symbol ${signal.symbol} not listed on ${SODEX_NETWORKS[network].label}.`,
        );
      }
      const clOrdID = `helix-${signal.signal_id}-${Date.now()}`;
      // For market BUYs, SoDEX accepts `funds` (USD-equivalent spend)
      // so we don't have to know the exact fill price up-front. For
      // SELLs, we need a base-asset `quantity` — derive from the
      // signal's reference price when available, else fall back to a
      // tiny no-op size that lets the user verify the wiring without
      // an unintended fill.
      const isBuy = signal.side === "buy";
      const referencePrice = signal.price_usd > 0 ? signal.price_usd : 0;
      const order: SodexNewOrderEntry = isBuy
        ? {
            symbolID: symbolId,
            clOrdID,
            side: SodexSide.BUY,
            type: SodexOrderType.MARKET,
            timeInForce: SodexTimeInForce.IOC,
            quantity: "0", // unused when `funds` is set on market buys
            funds: sizeUsd.toString(),
          }
        : {
            symbolID: symbolId,
            clOrdID,
            side: SodexSide.SELL,
            type: SodexOrderType.MARKET,
            timeInForce: SodexTimeInForce.IOC,
            quantity:
              referencePrice > 0
                ? (sizeUsd / referencePrice).toFixed(6)
                : "0.0001",
          };

      const sodexResp = await placeOrderBatch({
        network,
        apiKeyName: key.name,
        apiKeyPrivateKey: key.privateKey,
        batch: {
          accountID: state.aid,
          orders: [order],
        },
      });

      // Best-effort extract a SoDEX order id from the response for the
      // audit log. Shape isn't fully documented; we fall back to the
      // clOrdID if we can't find it.
      const sodexOrderId =
        (sodexResp as { orderID?: string })?.orderID ?? clOrdID;

      await fetch("/api/sodex/record-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_wallet: address,
          signal_id: signal.signal_id,
          network,
          symbol: signal.symbol,
          side: signal.side,
          size_usd: sizeUsd,
          filled_price: signal.price_usd > 0 ? signal.price_usd : null,
          sodex_order_id: sodexOrderId,
          status: "submitted",
        }),
      });

      setMsg(
        `✓ Order placed — ${signal.side.toUpperCase()} ~$${sizeUsd.toFixed(0)} ${signal.symbol} on ${SODEX_NETWORKS[network].label}`,
      );
    } catch (err) {
      const errMsg = (err as Error).message;
      setMsg(`✗ ${errMsg}`);
      // Log the rejection too — failed attempts are still data.
      try {
        await fetch("/api/sodex/record-trade", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_wallet: address,
            signal_id: signal.signal_id,
            network,
            symbol: signal.symbol,
            side: signal.side,
            size_usd: 0,
            status: "rejected",
            error: errMsg.slice(0, 500),
          }),
        });
      } catch {
        /* ignore audit-log failures */
      }
    } finally {
      setBusy(false);
    }
  }, [address, network, signal]);

  if (!isConnected || !ready) {
    return (
      <a
        href="/settings/connect-sodex"
        className="inline-flex items-center gap-2 rounded border border-line bg-surface px-2.5 py-1 text-xs text-fg-muted transition-colors hover:border-accent/40 hover:text-accent-2"
        title="Connect a wallet + generate an API key to enable live execution."
      >
        Connect SoDEX to execute live →
      </a>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={onClick}
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-2 rounded border px-2.5 py-1 text-xs font-medium transition-colors",
          busy
            ? "cursor-wait border-line bg-surface-2 text-fg-dim"
            : "border-accent/40 bg-accent/15 text-accent-2 hover:bg-accent/25",
        )}
        title={`${SODEX_NETWORKS[network].label} · ${signal.side.toUpperCase()} ~$${signal.suggested_size_usd.toFixed(0)} ${signal.symbol}`}
      >
        {busy
          ? "Signing…"
          : `▶ Execute live · ${SODEX_NETWORKS[network].label.replace("SoDEX ", "")}`}
      </button>
      {msg ? (
        <span
          className="text-[11px]"
          style={{ color: msg.startsWith("✗") ? "#e06c66" : "#5cc97a" }}
        >
          {msg}
        </span>
      ) : null}
    </div>
  );
}
