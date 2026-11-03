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
  classifyOrderResult,
  getAccountState,
  getPerpsAccountState,
  resolveSymbol,
  getLivePrice,
} from "./client";
import {
  readLocalKey,
  writeLocalKey,
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
  /** Order type. "MARKET" (default) keeps the original behaviour exactly;
   *  "LIMIT" submits a resting/marketable limit at `limitPrice`. */
  orderType?: "MARKET" | "LIMIT";
  /** LIMIT only — the price, already tick-rounded + range-validated by the
   *  caller. Quantity is sizeUsd/limitPrice rounded to the symbol precision. */
  limitPrice?: number;
  /** LIMIT only — time-in-force. POST_ONLY maps to SoDEX GTX (maker-only);
   *  default GTC (resting). IOC is marketable. */
  timeInForce?: "GTC" | "IOC" | "POST_ONLY";
  /** Reduce-only — closes/reduces an existing position, never opens or flips.
   *  Omitted/false keeps the MARKET + LIMIT entries byte-identical. */
  reduceOnly?: boolean;
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
    orderType = "MARKET",
    limitPrice,
    timeInForce = "GTC",
    reduceOnly,
    setMsg,
    setBusy,
    setConfirming,
    setTradesToday,
  } = args;
  const isLimit = orderType === "LIMIT";
    const key = readLocalKey(network);
    if (!key) {
      setMsg("✗ Set up a trading identity on /settings/connect-sodex first.");
      setConfirming(false);
      return;
    }
    // Size the user typed in the confirm panel (pre-filled from the signal).
    const sizeUsd = Number.parseFloat(sizeInput);
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) {
      setMsg("✗ Enter a size.");
      setConfirming(false);
      return;
    }
    // Opening/adding must clear SoDEX's ~$min notional; a reduce-only close may
    // be ANY size down to dust — you must always be able to close a position.
    if (!reduceOnly && sizeUsd < SODEX_MIN_NOTIONAL_USD) {
      setMsg(
        `✗ Size must be at least SoDEX's ~$${SODEX_MIN_NOTIONAL_USD} minimum.`,
      );
      setConfirming(false);
      return;
    }
    if (
      isLimit &&
      (!Number.isFinite(limitPrice as number) || (limitPrice as number) <= 0)
    ) {
      setMsg("✗ Enter a valid limit price.");
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
      let order: SodexNewOrderEntry =
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

      // LIMIT override (3b-pre). The MARKET `order` built above is left
      // byte-for-byte unchanged; for a LIMIT request we replace it with a LIMIT
      // entry that routes through the SAME placeOrderBatch, so the builder-fee
      // field attaches identically (placeOrderBatch injects `builder` type-
      // agnostically). No TP/SL brackets on LIMIT this commit — a reduce-only
      // bracket placed before a resting limit fills would misbehave.
      if (isLimit) {
        const limitPx = limitPrice as number;
        const limitQty = (sizeUsd / limitPx).toFixed(qtyPrecision);
        if (Number(limitQty) <= 0) {
          throw new Error(
            `Computed quantity ${limitQty} is zero — increase size or adjust the limit price.`,
          );
        }
        const pxDp = resolved.pricePrecision ?? 2;
        const tif =
          timeInForce === "IOC"
            ? SodexTimeInForce.IOC
            : timeInForce === "POST_ONLY"
              ? SodexTimeInForce.GTX
              : SodexTimeInForce.GTC;
        order = {
          symbolID: symbolId,
          clOrdID,
          side: isBuy ? SodexSide.BUY : SodexSide.SELL,
          type: SodexOrderType.LIMIT,
          timeInForce: tif,
          price: limitPx.toFixed(pxDp),
          quantity: limitQty,
        };
      }

      // Reduce-only (v3-2): close/reduce an existing position, never flip it.
      // Additive and optional — when omitted the MARKET and LIMIT entries above
      // are byte-identical. The builder fee still attaches (placeOrderBatch adds
      // it regardless of this flag).
      if (reduceOnly) order.reduceOnly = true;

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

      // A rejected entry already threw. An UNCONFIRMED one (no clear success or
      // error) is neither: never claim it filled OR failed — point the trader at
      // their positions, which the UI reads straight from SoDEX.
      if (classifyOrderResult(sodexResp).status === "unconfirmed") {
        setMsg("⚠ Order status unconfirmed — check your positions on SoDEX.");
        return;
      }

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
      if (!isLimit && market === "futures" && referencePrice > 0) {
        const stopPct = Number.parseFloat(stopInput);
        const targetPct = Number.parseFloat(targetInput);
        const pxDp = resolved.pricePrecision ?? 4;
        const closeSide = isBuy ? SodexSide.SELL : SodexSide.BUY;
        const placeStop = async (tag: string, trigger: number, stopType: number) => {
          const clid = `helix-${tag}${Date.now().toString(36)}${Math.random()
            .toString(36)
            .slice(2, 4)}`.slice(0, 36);
          const resp = await placeOrderBatch({
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
          // A rejected leg already threw inside placeOrderBatch; here it is
          // either accepted or genuinely unconfirmed.
          return classifyOrderResult(resp).status;
        };
        // The entry already filled, so a bracket leg that is rejected or
        // unconfirmed is NOT a failed order — surfacing it as "failed" would
        // tempt a retry that doubles the position. Placed legs render as
        // "SL 5%"; a rejection as "✗ SL rejected: <SoDEX reason>"; an
        // unconfirmed leg points the trader at their positions.
        const placed: string[] = [];
        const issues: string[] = [];
        if (Number.isFinite(stopPct) && stopPct > 0) {
          const trig = isBuy
            ? referencePrice * (1 - stopPct / 100)
            : referencePrice * (1 + stopPct / 100);
          try {
            const st = await placeStop("sl", trig, 1);
            if (st === "unconfirmed")
              issues.push("⚠ SL unconfirmed — check positions");
            else placed.push(`SL ${stopPct}%`);
          } catch (e) {
            issues.push(`✗ SL rejected: ${(e as Error).message}`);
          }
        }
        if (Number.isFinite(targetPct) && targetPct > 0) {
          const trig = isBuy
            ? referencePrice * (1 + targetPct / 100)
            : referencePrice * (1 - targetPct / 100);
          try {
            const st = await placeStop("tp", trig, 2);
            if (st === "unconfirmed")
              issues.push("⚠ TP unconfirmed — check positions");
            else placed.push(`TP ${targetPct}%`);
          } catch (e) {
            issues.push(`✗ TP rejected: ${(e as Error).message}`);
          }
        }
        if (placed.length) bracket += ` · ${placed.join(" · ")}`;
        if (issues.length) bracket += ` · ${issues.join(" · ")}`;
      }

      const verb = reduceOnly
        ? "Closed"
        : signal.side.toLowerCase() === "buy"
          ? "Bought"
          : "Sold";
      const sizeStr = sizeUsd.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      const mkt = fmtSodexSymbol(signal.symbol).replace(/-USDC?$/i, "-PERP");
      setMsg(
        `✓ ${verb} $${sizeStr} ${mkt} on ${SODEX_NETWORKS[network].label}${bracket}`,
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

/**
 * placeTriggerForPosition — place a standalone reduce-only STOP (TP or SL) for
 * an EXISTING open position, at an ABSOLUTE trigger price. Same order shape as
 * the placeStop bracket in placeLiveOrder (reduce-only MARKET STOP, trigger on
 * mark), but driven by the position rather than a just-filled entry. The
 * builder fee attaches via placeOrderBatch. The caller rounds stopPrice to the
 * tick size and quantity to the step size. This is additive — it does not
 * touch the MARKET / LIMIT / reduceOnly paths above.
 */
export interface PlaceTriggerArgs {
  network: SodexNetwork;
  apiKeyName?: string;
  privateKey: `0x${string}`;
  accountID: number;
  symbolID: number;
  /** Position direction — a long closes with SELL, a short with BUY. */
  positionIsLong: boolean;
  /** Position quantity in base units, already step-rounded. */
  quantity: string;
  /** Absolute trigger price, already tick-rounded (string). */
  stopPrice: string;
  /** 2 = take-profit, 1 = stop-loss. */
  stopType: number;
}

export async function placeTriggerForPosition(
  args: PlaceTriggerArgs,
): Promise<{ clOrdID: string }> {
  const {
    network,
    apiKeyName,
    privateKey,
    accountID,
    symbolID,
    positionIsLong,
    quantity,
    stopPrice,
    stopType,
  } = args;
  const tag = stopType === 2 ? "tp" : "sl";
  const clOrdID = `helix-${tag}${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 4)}`.slice(0, 36);
  await placeOrderBatch({
    network,
    apiKeyName,
    privateKey,
    market: "futures",
    batch: {
      accountID,
      orders: [
        {
          symbolID,
          clOrdID,
          side: positionIsLong ? SodexSide.SELL : SodexSide.BUY,
          type: SodexOrderType.MARKET,
          timeInForce: SodexTimeInForce.IOC,
          quantity,
          modifier: SodexModifier.STOP,
          stopPrice,
          stopType,
          triggerType: 2, // MARK_PRICE (matches the bracket path)
          reduceOnly: true,
          positionSide: 1,
        },
      ],
    },
  });
  // Return the clOrdID so the caller can confirm the order actually rests on
  // SoDEX (open-orders re-read) before treating the placement as succeeded.
  return { clOrdID };
}
