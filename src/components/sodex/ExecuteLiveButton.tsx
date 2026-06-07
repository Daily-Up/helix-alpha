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
import { useAccount } from "wagmi";
import {
  SODEX_NETWORKS,
  type SodexNetwork,
} from "@/lib/sodex-onchain/chains";
import {
  placeOrderBatch,
  getAccountState,
  getSymbolId,
  getLivePrice,
} from "@/lib/sodex-onchain/client";
import {
  readLocalKey,
  readSafetyLimits,
  writeLocalKey,
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

  // Wagmi-connected master wallet. We use it for two things:
  //   1. Self-heal legacy stored keys that don't carry `masterAddress`
  //      yet (everyone created before the storage change).
  //   2. Fall back at trade time if the stored key still has no master
  //      recorded (e.g. user wiped their key on another machine).
  const { address: connectedMaster } = useAccount();

  // ── Readiness ──
  const [ready, setReady] = useState(false);
  const [identityAddress, setIdentityAddress] = useState<
    `0x${string}` | null
  >(null);
  useEffect(() => {
    const key = readLocalKey(network);
    // Migrate legacy localStorage rows: when the stored key has no
    // masterAddress and the user has a wallet connected, persist the
    // master so future Execute Live clicks work without a re-create.
    if (key && !key.masterAddress && connectedMaster) {
      writeLocalKey(network, { ...key, masterAddress: connectedMaster });
    }
    const limits = readSafetyLimits(network);
    setReady(!!key && limits.acceptedDisclaimer);
    setIdentityAddress(key?.address ?? null);
  }, [network, connectedMaster]);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const onClick = useCallback(async () => {
    const key = readLocalKey(network);
    if (!key) {
      setMsg("Set up a trading identity on /settings/connect-sodex first.");
      return;
    }
    const limits = readSafetyLimits(network);
    // TEMP: hardcode every live order to 11 USDC for the buildathon.
    //
    // SoDEX's minNotional varies per pair — vBTC_vUSDC's is $5, but
    // some pairs sit at $10, and a 10 USDC order can fail with
    // "quantity is invalid" when the derived qty rounds below
    // marketMinQuantity. 11 USDC gives us a safety margin above the
    // documented minimums while still being a token-size sanity test.
    //
    // We still respect the user's per-trade max — if they capped at
    // <$11, refuse rather than silently overspend.
    const sizeUsd = 11;
    if (limits.maxPositionUsd < sizeUsd) {
      setMsg(
        `Your per-trade max ($${limits.maxPositionUsd}) is below the live floor ($${sizeUsd}). Raise it on /settings/connect-sodex.`,
      );
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      // SoDEX accounts live on the MASTER wallet that signed addAPIKey,
      // not on the API-key address. Priority for the lookup address:
      //   1. key.masterAddress (recorded at create time)
      //   2. wagmi's currently-connected master (live fallback)
      //   3. key.address (burner-wallet path: the key IS the account)
      // For mainnet master+API-key flow the master is required, or
      // SoDEX rejects the order with
      //   "Field validation for 'AccountID' failed on the 'required' tag"
      // because state.aid resolves to 0 for an unregistered address.
      const accountLookupAddress =
        key.masterAddress ?? connectedMaster ?? key.address;
      const state = await getAccountState(network, accountLookupAddress);
      if (!state.aid) {
        throw new Error(
          "SoDEX account not found for this wallet. Connect your master wallet (the one you used on /settings/connect-sodex) — Helix will self-heal and you can click Execute again.",
        );
      }
      // If we resolved via the live wagmi address (legacy path), persist
      // it onto the key so future trades skip the wallet dependency.
      if (!key.masterAddress && accountLookupAddress !== key.address) {
        writeLocalKey(network, {
          ...key,
          masterAddress: accountLookupAddress,
        });
      }
      let symbolId = signal.symbol_id;
      if (symbolId == null) {
        symbolId = await getSymbolId(network, signal.symbol);
      }
      if (symbolId == null) {
        throw new Error(
          `Symbol ${signal.symbol} not listed on ${SODEX_NETWORKS[network].label}.`,
        );
      }
      // SoDEX validates clOrdID against ^[0-9a-zA-Z_-]{1,36}$ and
      // requires uniqueness across an account's OPEN orders. Our
      // previous format `helix-${signal_uuid}-${ms_epoch}` was 56
      // chars (UUID alone is 36) and SoDEX rejected with
      // "clOrdID is invalid". Pack it tighter:
      //   helix-{first 8 of signal_id, hyphens stripped}-{base36 ms}
      //         6+1                 +8               +1 +~8  = ~24
      // The base36 timestamp suffix guarantees per-tick uniqueness; a
      // user double-clicking inside the same millisecond would still
      // collide, so we belt-and-suspenders with a 4-char random tail.
      const sigSlug = signal.signal_id.replace(/-/g, "").slice(0, 8);
      const tsB36 = Date.now().toString(36);
      const rnd = Math.random().toString(36).slice(2, 6);
      const clOrdID = `helix-${sigSlug}-${tsB36}${rnd}`.slice(0, 36);
      // Last-line sanity check — if any of the inputs ever produce a
      // bad char, fail in our code rather than at the gateway with a
      // generic "invalid" message.
      if (!/^[0-9a-zA-Z_-]{1,36}$/.test(clOrdID)) {
        throw new Error(
          `Generated clOrdID "${clOrdID}" doesn't match SoDEX format. Refresh and try again.`,
        );
      }
      // Earlier this code sent { quantity: "0", funds: <usd> } on
      // market BUYs, expecting SoDEX to compute the size from funds.
      // The gateway rejects that with "quantity is invalid" because
      // every spot symbol has a `marketMinQuantity` (≥ 0.00001 on
      // every market we've seen) and "0" is below the floor.
      //
      // The robust fix is to compute the size client-side from the
      // signal's reference price, round to a precision that comfortably
      // satisfies stepSize for the common spot pairs, and send BOTH
      // `quantity` and (for buys) `funds`. SoDEX accepts the order;
      // if the realised fill differs from `funds` because of slippage,
      // the matched leg respects whichever side of the order book is
      // valid.
      //
      // Precision: vBTC has quantityPrecision=5 (stepSize 0.00001),
      // vETH=5, vSOL=4. We use 5 decimals universally — under-rounds
      // for SOL but well above the floor; for the larger-cap pairs
      // it matches the spec.
      const isBuy = signal.side === "buy";
      // SignalCard passes price_usd=0 — it's a market order, the price
      // is resolved at click time from SoDEX's live ticker. Use the
      // best ask for BUY (you cross up) and best bid for SELL (you
      // cross down); fall back to lastPx if either side is empty.
      // signal.price_usd is honoured as a last-ditch fallback so a
      // future signal that DOES carry a price still works.
      let referencePrice = await getLivePrice(network, signal.symbol, signal.side);
      if (!referencePrice && signal.price_usd > 0) {
        referencePrice = signal.price_usd;
      }
      if (!referencePrice || referencePrice <= 0) {
        throw new Error(
          `Couldn't fetch a live price for ${signal.symbol} from SoDEX. Try again in a moment.`,
        );
      }
      const qty = (sizeUsd / referencePrice).toFixed(5);
      if (Number(qty) <= 0) {
        throw new Error(
          `Computed quantity ${qty} is zero — increase position size or check the price feed.`,
        );
      }
      // SoDEX market orders accept EXACTLY ONE of {quantity, funds}:
      //   BUY  — `funds` (USD spend); gateway derives quantity at fill
      //   SELL — `quantity` (base-asset size)
      // Sending both → "quantity and funds cannot be set at the same time".
      // Sending neither, or `quantity: "0"`, → "quantity is invalid".
      const order: SodexNewOrderEntry = isBuy
        ? {
            symbolID: symbolId,
            clOrdID,
            side: SodexSide.BUY,
            type: SodexOrderType.MARKET,
            timeInForce: SodexTimeInForce.IOC,
            funds: sizeUsd.toString(),
          }
        : {
            symbolID: symbolId,
            clOrdID,
            side: SodexSide.SELL,
            type: SodexOrderType.MARKET,
            timeInForce: SodexTimeInForce.IOC,
            quantity: qty,
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
