"use client";

/**
 * Live-execution button for a signal.
 *
 * Renders ONLY when the user has:
 *   1. A Helix-scoped SoDEX API key for mainnet (localStorage).
 *   2. Accepted the safety-limits disclaimer.
 *
 * Click flow (TWO explicit steps — this places a REAL mainnet order):
 *   click "Execute live" → inline confirm shows the exact side / USD /
 *   symbol / "real funds" → click "Confirm" → browser builds order params
 *   → signs with the local private key → POSTs to the SoDEX gateway
 *   directly → records the public outcome to /api/sodex/record-trade.
 *
 * Sizing: the live order size IS the user's per-trade max (`maxPositionUsd`)
 * — the single size knob on the Connect page. The button, the confirm
 * panel, and the result toast ALL show this same number, so what's shown
 * is what's charged. Helix's server is never on the critical path.
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
  getPerpsAccountState,
  resolveSymbol,
  getLivePrice,
} from "@/lib/sodex-onchain/client";
import {
  readLocalKey,
  readSafetyLimits,
  writeLocalKey,
  readTradesToday,
  recordTradeToday,
  SODEX_MIN_NOTIONAL_USD,
} from "@/lib/sodex-onchain/local-keys";
import { fmtSodexSymbol } from "@/lib/format";
import {
  SodexModifier,
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
  /** Suggested size in USD — pre-fills the editable size field. */
  suggested_size_usd: number;
  /** Suggested stop-loss / take-profit %, pre-fill the SL/TP fields. */
  stop_pct?: number | null;
  target_pct?: number | null;
  /** Current market price used for the optimistic display. */
  price_usd: number;
}

interface Props {
  signal: ExecuteLiveSignal;
}

export function ExecuteLiveButton({ signal }: Props) {
  // Mainnet only — testnet was scoped out.
  const network: SodexNetwork = "mainnet";

  const { address: connectedMaster } = useAccount();

  // ── Readiness + live params ──
  const [ready, setReady] = useState(false);
  const [identityAddress, setIdentityAddress] = useState<
    `0x${string}` | null
  >(null);
  const [maxDaily, setMaxDaily] = useState(3);
  const [tradesToday, setTradesToday] = useState(0);
  // Editable order params — pre-filled from the signal, then user-adjustable
  // in the confirm panel. Strings so the inputs can be cleared/typed freely.
  const [sizeInput, setSizeInput] = useState("");
  const [stopInput, setStopInput] = useState(
    signal.stop_pct != null ? String(signal.stop_pct) : "",
  );
  const [targetInput, setTargetInput] = useState(
    signal.target_pct != null ? String(signal.target_pct) : "",
  );

  const refreshState = useCallback(() => {
    const key = readLocalKey(network);
    if (key && !key.masterAddress && connectedMaster) {
      writeLocalKey(network, { ...key, masterAddress: connectedMaster });
    }
    const limits = readSafetyLimits(network);
    setReady(!!key && limits.acceptedDisclaimer);
    setIdentityAddress(key?.address ?? null);
    // Seed size from the signal's suggestion, falling back to the per-trade
    // safety size. Only when empty so we don't clobber the user's edit.
    setSizeInput((prev) =>
      prev !== ""
        ? prev
        : String(signal.suggested_size_usd || limits.maxPositionUsd || 11),
    );
    setMaxDaily(limits.maxDailyTrades);
    setTradesToday(readTradesToday(network));
  }, [network, connectedMaster, signal.suggested_size_usd]);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Step 1 — validate limits, then reveal the confirm panel. No signing
  // or network call happens here.
  const requestExecute = useCallback(() => {
    const limits = readSafetyLimits(network);
    const used = readTradesToday(network);
    if (used >= limits.maxDailyTrades) {
      setMsg(
        `✗ Daily live-trade limit reached (${used}/${limits.maxDailyTrades}). Resets 00:00 UTC — or raise it on /settings/connect-sodex.`,
      );
      return;
    }
    setMsg(null);
    setConfirming(true);
  }, [network]);

  // Step 2 — the real thing. Signs and submits the order.
  const execute = useCallback(async () => {
    const key = readLocalKey(network);
    if (!key) {
      setMsg("✗ Set up a trading identity on /settings/connect-sodex first.");
      setConfirming(false);
      return;
    }
    const limits = readSafetyLimits(network);
    // Size the user typed in the confirm panel (pre-filled from the signal).
    const sizeUsd = Number.parseFloat(sizeInput);
    if (!Number.isFinite(sizeUsd) || sizeUsd < SODEX_MIN_NOTIONAL_USD) {
      setMsg(
        `✗ Size must be at least SoDEX's ~$${SODEX_MIN_NOTIONAL_USD} minimum.`,
      );
      setConfirming(false);
      return;
    }
    if (readTradesToday(network) >= limits.maxDailyTrades) {
      setMsg(`✗ Daily live-trade limit reached (${limits.maxDailyTrades}).`);
      setConfirming(false);
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const accountLookupAddress =
        key.masterAddress ?? connectedMaster ?? key.address;

      // Resolve the symbol across BOTH venues. Perp-only assets (DASH-USD…)
      // are absent from the spot catalog — a spot-only lookup wrongly says
      // "not listed". resolveSymbol finds the market and we route to it.
      const resolved = await resolveSymbol(network, signal.symbol);
      if (!resolved) {
        throw new Error(
          `Symbol ${fmtSodexSymbol(signal.symbol)} not listed on ${SODEX_NETWORKS[network].label} (spot or perps).`,
        );
      }
      const { id: symbolId, market } = resolved;

      // Account (aid) comes from the matching venue — spot vs perps.
      const state =
        market === "futures"
          ? await getPerpsAccountState(network, accountLookupAddress)
          : await getAccountState(network, accountLookupAddress);
      if (!state.aid) {
        throw new Error(
          market === "futures"
            ? "No SoDEX perps account for this wallet yet — open it on SoDEX (deposit margin) once, then Execute again."
            : "SoDEX account not found for this wallet. Connect your master wallet (the one you used on /settings/connect-sodex) — Helix will self-heal and you can click Execute again.",
        );
      }
      if (!key.masterAddress && accountLookupAddress !== key.address) {
        writeLocalKey(network, {
          ...key,
          masterAddress: accountLookupAddress,
        });
      }
      // clOrdID must match ^[0-9a-zA-Z_-]{1,36}$ and be unique across an
      // account's open orders. Pack: helix-{8 of id}-{base36 ms}{4 rnd}.
      const sigSlug = signal.signal_id.replace(/-/g, "").slice(0, 8);
      const tsB36 = Date.now().toString(36);
      const rnd = Math.random().toString(36).slice(2, 6);
      const clOrdID = `helix-${sigSlug}-${tsB36}${rnd}`.slice(0, 36);
      if (!/^[0-9a-zA-Z_-]{1,36}$/.test(clOrdID)) {
        throw new Error(
          `Generated clOrdID "${clOrdID}" doesn't match SoDEX format. Refresh and try again.`,
        );
      }
      const isBuy = signal.side === "buy";
      // Market order — resolve the reference price from the matching venue's
      // live ticker (best ask for buys, best bid for sells). signal.price_usd
      // is a last-ditch fallback.
      let referencePrice = await getLivePrice(
        network,
        signal.symbol,
        signal.side,
        market,
      );
      if (!referencePrice && signal.price_usd > 0) {
        referencePrice = signal.price_usd;
      }
      if (!referencePrice || referencePrice <= 0) {
        throw new Error(
          `Couldn't fetch a live price for ${fmtSodexSymbol(signal.symbol)} from SoDEX. Try again in a moment.`,
        );
      }
      // Round to the market's own quantity precision — perps reject anything
      // finer (DASH = 2dp / 0.01 step → "quantity is invalid" on 5dp).
      const qtyPrecision = resolved.quantityPrecision ?? 5;
      const qty = (sizeUsd / referencePrice).toFixed(qtyPrecision);
      if (Number(qty) <= 0) {
        throw new Error(
          `Computed quantity ${qty} is zero — increase position size or check the price feed.`,
        );
      }
      // Order params by venue. Spot MARKET accepts exactly one of
      // {funds, quantity}: BUY→funds (USD), SELL→quantity. Futures (perps)
      // are quantity-based for both sides — the side alone sets long/short.
      const order: SodexNewOrderEntry =
        market === "futures"
          ? {
              symbolID: symbolId,
              clOrdID,
              side: isBuy ? SodexSide.BUY : SodexSide.SELL,
              type: SodexOrderType.MARKET,
              timeInForce: SodexTimeInForce.IOC,
              quantity: qty,
            }
          : isBuy
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
        apiKeyName: key.name || undefined,
        privateKey: key.privateKey,
        market,
        batch: {
          accountID: state.aid,
          orders: [order],
        },
      });

      const sodexOrderId =
        (sodexResp as { orderID?: string })?.orderID ?? clOrdID;

      // Count the successful submit against the daily cap.
      const nowCount = recordTradeToday(network);
      setTradesToday(nowCount);

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

      // ── Attach SL / TP as reduce-only stop orders (perps only). The entry
      //    already filled; these are best-effort so a bracket failure never
      //    unwinds a successful entry — we just surface it.
      let bracket = "";
      if (market === "futures" && referencePrice > 0) {
        const stopPct = Number.parseFloat(stopInput);
        const targetPct = Number.parseFloat(targetInput);
        const pxDp = resolved.pricePrecision ?? 4;
        const closeSide = isBuy ? SodexSide.SELL : SodexSide.BUY;
        const placeStop = async (tag: string, trigger: number, stopType: number) => {
          const clid = `helix-${tag}${Date.now().toString(36)}${Math.random()
            .toString(36)
            .slice(2, 4)}`.slice(0, 36);
          await placeOrderBatch({
            network,
            apiKeyName: key.name || undefined,
            privateKey: key.privateKey,
            market,
            batch: {
              accountID: state.aid,
              orders: [
                {
                  symbolID: symbolId,
                  clOrdID: clid,
                  side: closeSide,
                  type: SodexOrderType.MARKET,
                  timeInForce: SodexTimeInForce.IOC,
                  quantity: qty,
                  modifier: SodexModifier.STOP,
                  stopPrice: trigger.toFixed(pxDp),
                  stopType,
                  triggerType: 2, // MARK_PRICE (1=LAST was rejected; docs trigger on mark)
                  reduceOnly: true,
                  positionSide: 1,
                },
              ],
            },
          });
        };
        const placed: string[] = [];
        const failed: string[] = [];
        if (Number.isFinite(stopPct) && stopPct > 0) {
          const trig = isBuy
            ? referencePrice * (1 - stopPct / 100)
            : referencePrice * (1 + stopPct / 100);
          try {
            await placeStop("sl", trig, 1);
            placed.push(`SL ${stopPct}%`);
          } catch (e) {
            failed.push(`SL: ${(e as Error).message}`);
          }
        }
        if (Number.isFinite(targetPct) && targetPct > 0) {
          const trig = isBuy
            ? referencePrice * (1 + targetPct / 100)
            : referencePrice * (1 - targetPct / 100);
          try {
            await placeStop("tp", trig, 2);
            placed.push(`TP ${targetPct}%`);
          } catch (e) {
            failed.push(`TP: ${(e as Error).message}`);
          }
        }
        if (placed.length) bracket += ` · ${placed.join(" · ")}`;
        if (failed.length) bracket += ` · ⚠ ${failed.join("; ")}`;
      }

      setMsg(
        `✓ ${signal.side.toUpperCase()} $${sizeUsd} ${fmtSodexSymbol(signal.symbol)} on ${SODEX_NETWORKS[network].label}${bracket}`,
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
      setConfirming(false);
    }
  }, [
    network,
    signal,
    identityAddress,
    connectedMaster,
    sizeInput,
    stopInput,
    targetInput,
  ]);

  if (!ready) {
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

  const sideLabel = signal.side.toUpperCase();
  const symLabel = fmtSodexSymbol(signal.symbol);

  return (
    <div className="flex flex-col gap-1.5">
      {confirming ? (
        // ── Explicit confirmation — a REAL order is one click away ──
        <div className="rounded border border-accent/40 bg-accent/10 p-2.5 text-xs">
          <div className="text-fg-muted">
            Real{" "}
            <span
              className={cn(
                "font-medium",
                signal.side === "buy" ? "text-positive" : "text-negative",
              )}
            >
              {sideLabel}
            </span>{" "}
            on {symLabel} — <span className="text-fg">real funds</span> on{" "}
            {SODEX_NETWORKS[network].label}. Stop / target become reduce-only
            brackets on perps.
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {(
              [
                ["Size $", sizeInput, setSizeInput, "text-fg", undefined],
                ["Stop %", stopInput, setStopInput, "text-negative", "off"],
                ["Target %", targetInput, setTargetInput, "text-positive", "off"],
              ] as const
            ).map(([label, val, setter, color, ph]) => (
              <label key={label} className="flex flex-col gap-0.5">
                <span className="font-[var(--font-jetbrains-mono)] text-[9px] uppercase tracking-wider text-fg-dim">
                  {label}
                </span>
                <input
                  value={val}
                  onChange={(e) => setter(e.target.value)}
                  inputMode="decimal"
                  placeholder={ph}
                  disabled={busy}
                  className={cn(
                    "w-full rounded border border-line bg-surface px-1.5 py-1 text-xs tabular-nums outline-none focus:border-accent/50",
                    color,
                  )}
                />
              </label>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={execute}
              disabled={busy}
              className={cn(
                "rounded border px-2.5 py-1 text-xs font-medium transition-colors",
                busy
                  ? "cursor-wait border-line bg-surface-2 text-fg-dim"
                  : "border-accent bg-accent text-[#0b0b0e] hover:bg-accent-2",
              )}
            >
              {busy ? "Signing…" : `Confirm · $${sizeInput}`}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded border border-line px-2.5 py-1 text-xs text-fg-muted transition-colors hover:border-line-2 hover:text-fg"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={requestExecute}
          disabled={busy}
          className={cn(
            "inline-flex items-center gap-2 rounded border px-2.5 py-1 text-xs font-medium transition-colors",
            "border-accent/40 bg-accent/15 text-accent-2 hover:bg-accent/25",
          )}
          title={`${SODEX_NETWORKS[network].label} · ${sideLabel} ${symLabel} — set size, stop & target on confirm`}
        >
          {`▶ Execute live · $${sizeInput}`}
        </button>
      )}
      {msg ? (
        <span
          className="text-[11px]"
          style={{ color: msg.startsWith("✗") ? "#e06c66" : "#5cc97a" }}
        >
          {msg}
        </span>
      ) : null}
      {!confirming && tradesToday > 0 ? (
        <span className="text-[10px] text-fg-dim">
          {tradesToday}/{maxDaily} live trades today
        </span>
      ) : null}
    </div>
  );
}
