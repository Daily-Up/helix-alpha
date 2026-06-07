"use client";

/**
 * Single-click live-execution button for a signal.
 *
 * Renders ONLY when the user has:
 *   1. A trading identity for the active network (either a burner
 *      wallet on testnet, or a Helix API key on mainnet — both stored
 *      in browser localStorage at helix.sodex.identity.<network>).
 *   2. Accepted the safety-limits disclaimer.
 *
 * Click flow:
 *   browser → builds order params → signs with the local private key
 *   → POSTs to SoDEX gateway DIRECTLY → on response, posts the public
 *   outcome to /api/sodex/record-trade for the audit log.
 *
 * Helix's server is NEVER on the critical path of the trade.
 */

import { useCallback, useEffect, useState } from "react";
import {
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
  // Mainnet only — testnet was scoped out.
  const network: SodexNetwork = "mainnet";

  // ── Readiness ──
  const [ready, setReady] = useState(false);
  const [identityAddress, setIdentityAddress] = useState<
    `0x${string}` | null
  >(null);
  useEffect(() => {
    const key = readLocalKey(network);
    const limits = readSafetyLimits(network);
    setReady(!!key && limits.acceptedDisclaimer);
    setIdentityAddress(key?.address ?? null);
  }, [network]);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const onClick = useCallback(async () => {
    const key = readLocalKey(network);
    if (!key) {
      setMsg("Set up a trading identity on /settings/connect-sodex first.");
      return;
    }
    const limits = readSafetyLimits(network);
    const sizeUsd = Math.min(
      signal.suggested_size_usd,
      limits.maxPositionUsd,
    );
    if (sizeUsd <= 0) {
      setMsg("Position size cap is 0 — edit your safety limits.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const state = await getAccountState(network, key.address);
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
      // Market BUY → use SoDEX `funds` (USD spend). Market SELL needs
      // a base-asset `quantity`; derive from the signal's reference
      // price when present.
      const isBuy = signal.side === "buy";
      const referencePrice = signal.price_usd > 0 ? signal.price_usd : 0;
      const order: SodexNewOrderEntry = isBuy
        ? {
            symbolID: symbolId,
            clOrdID,
            side: SodexSide.BUY,
            type: SodexOrderType.MARKET,
            timeInForce: SodexTimeInForce.IOC,
            quantity: "0",
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
        // Empty name == burner mode (no X-API-Key header).
        apiKeyName: key.name || undefined,
        privateKey: key.privateKey,
        batch: {
          accountID: state.aid,
          orders: [order],
        },
      });

      const sodexOrderId =
        (sodexResp as { orderID?: string })?.orderID ?? clOrdID;

      await fetch("/api/sodex/record-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_wallet: key.address,
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
      try {
        if (identityAddress) {
          await fetch("/api/sodex/record-trade", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              user_wallet: identityAddress,
              signal_id: signal.signal_id,
              network,
              symbol: signal.symbol,
              side: signal.side,
              size_usd: 0,
              status: "rejected",
              error: errMsg.slice(0, 500),
            }),
          });
        }
      } catch {
        /* ignore audit-log failures */
      }
    } finally {
      setBusy(false);
    }
  }, [network, signal, identityAddress]);

  if (!ready) {
    // Two failure modes lead here:
    //   1. No SoDEX trading key in this browser → user needs to create
    //      one (the dominant case for new visitors).
    //   2. Key exists but they haven't ticked the safety-limits
    //      disclaimer.
    // We frame the CTA toward the dominant path because the connect
    // page handles either case once they land on it.
    const hasKey = identityAddress != null;
    return (
      <a
        href="/settings/connect-sodex"
        className="inline-flex items-center gap-2 rounded border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs text-accent-2 transition-colors hover:border-accent/60 hover:bg-accent/20"
        title={
          hasKey
            ? "You have a key but haven't accepted the safety-limits disclaimer yet — click to finish setup."
            : "Connect your wallet on SoDEX mainnet and generate a Helix-scoped API key. Your master wallet signs once; the trading key lives only in this browser."
        }
      >
        {hasKey
          ? "Accept disclaimer to execute live →"
          : "→ Create SoDEX API key to execute live"}
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
