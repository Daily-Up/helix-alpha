/**
 * placeLiveOrder — the build/sign/submit path for a live SoDEX order,
 * extracted VERBATIM from ExecuteLiveButton.execute (commit 3a). The logic
 * (symbol resolution, account lookup, order construction, placeOrderBatch
 * with the builder-fee params, record-trade, SL/TP brackets) is unchanged;
 * the only edits are this wrapper + destructuring component state/props into
 * `args`. Both ExecuteLiveButton and the terminal OrderPanel call this.
 */

import { SODEX_NETWORKS, type SodexNetwork } from "./chains";
import {
  placeOrderBatch,
  getAccountState,
  getPerpsAccountState,
  resolveSymbol,
  getLivePrice,
} from "./client";
import {
  readLocalKey,
  readSafetyLimits,
  writeLocalKey,
  readTradesToday,
  recordTradeToday,
  SODEX_MIN_NOTIONAL_USD,
} from "./local-keys";
import { fmtSodexSymbol } from "@/lib/format";
import {
  SodexModifier,
  SodexOrderType,
  SodexSide,
  SodexTimeInForce,
  type SodexNewOrderEntry,
} from "./types";

export interface PlaceLiveOrderArgs {
  network: SodexNetwork;
  /** Only the fields execute reads: id, symbol, side, fallback price. */
  signal: {
    signal_id: string;
    symbol: string;
    side: "buy" | "sell";
    price_usd: number;
  };
  identityAddress: `0x${string}` | null;
  connectedMaster: `0x${string}` | undefined;
  /** Captured at Confirm time by the caller (strings, parsed inside). */
  sizeInput: string;
  stopInput: string;
  targetInput: string;
  /** UI-state writers — kept as callbacks so the body stays verbatim. */
  setMsg: (m: string | null) => void;
  setBusy: (b: boolean) => void;
  setConfirming: (c: boolean) => void;
  setTradesToday: (n: number) => void;
}

export async function placeLiveOrder(args: PlaceLiveOrderArgs): Promise<void> {
  const {
    network,
    signal,
    identityAddress,
    connectedMaster,
    sizeInput,
    stopInput,
    targetInput,
    setMsg,
    setBusy,
    setConfirming,
    setTradesToday,
  } = args;
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
}
