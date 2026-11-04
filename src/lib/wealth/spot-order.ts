"use client";

/**
 * Wealth ETF spot-order path — SEPARATE from placeLiveOrder (which is untouched).
 *
 * The Curated ETFs + vBOXX + vSTRC are `clob` spot pairs (vQQQ_vUSDC, …). This
 * builds a MARKET IOC spot order and submits it through the SHARED, unchanged
 * `placeOrderBatch` primitive — which already signs with the trading API key,
 * injects Helix's builder code (`{id:8409, fee:10}`) at the batch level for
 * BOTH buy and sell orders (the SoDEX spot engine only charges it on sells),
 * and honours NEXT_PUBLIC_SODEX_DRY_RUN. No perps code is involved.
 *
 * Buys spend USDC (`funds`); sells spend base units (`quantity`) — exactly one
 * of the two on a spot MARKET order.
 */

import {
  classifyOrderResult,
  getAccountState,
  placeOrderBatch,
  resolveSymbol,
  type SodexSymbolMeta,
} from "@/lib/sodex-onchain/client";
import { readLocalKey } from "@/lib/sodex-onchain/local-keys";
import {
  SodexOrderType,
  SodexSide,
  SodexTimeInForce,
  type SodexNewOrderEntry,
} from "@/lib/sodex-onchain/types";
import type { WealthFundView } from "./types";

const NETWORK = "mainnet" as const;

/** Beta flag — ETF Buy/Sell panel is off until enabled. Env turns it on for
 *  everyone; the localStorage key lets the owner test privately on prod. */
export function wealthInvestEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_WEALTH_SPOT_INVEST === "1") return true;
  if (typeof window !== "undefined") {
    try {
      return window.localStorage.getItem("helix.wealth.invest.beta") === "1";
    } catch {
      /* ignore */
    }
  }
  return false;
}

export type WealthOrderResult =
  | { kind: "dry_run"; payload: unknown }
  | { kind: "ok"; orderID: string | number | null }
  | { kind: "rejected"; reason: string }
  | { kind: "unconfirmed" };

export interface WealthSpotOrderInput {
  fund: WealthFundView;
  side: "buy" | "sell";
  /** BUY: USDC to spend (decimal string). */
  funds?: string;
  /** SELL: base units to sell (decimal string, already rounded to step). */
  quantity?: string;
}

/** Load the spot market metadata (id + sizing rules) for a fund's pair. */
export async function wealthSymbolMeta(
  fund: WealthFundView,
): Promise<SodexSymbolMeta | undefined> {
  if (!fund.spotSymbol) return undefined;
  return resolveSymbol(NETWORK, fund.spotSymbol);
}

/** Available vUSDC in the connected wallet's SoDEX spot account. */
export async function spotUsdcBalance(
  owner: `0x${string}`,
): Promise<{ usdc: number; aid: number }> {
  const state = await getAccountState(NETWORK, owner);
  const aid = Number(state.aid) || 0;
  const row = (state.B ?? []).find((b) => /usdc/i.test(b.a));
  const total = row ? Number(row.t) || 0 : 0;
  const locked = row ? Number(row.l) || 0 : 0;
  return { usdc: Math.max(0, total - locked), aid };
}

export function roundDownToStep(units: number, stepSize?: string): number {
  const step = stepSize ? Number(stepSize) : 0;
  if (!step || !Number.isFinite(step) || step <= 0) return units;
  return Math.floor(units / step) * step;
}

/**
 * Place a wealth ETF spot MARKET order. Returns a DRY_RUN payload when
 * NEXT_PUBLIC_SODEX_DRY_RUN=1, otherwise the classified gateway outcome.
 */
export async function placeWealthSpotOrder(
  input: WealthSpotOrderInput,
): Promise<WealthOrderResult> {
  const { fund, side } = input;
  if (!fund.spotSymbol) {
    throw new Error(`${fund.displayName} isn't a spot-tradable fund.`);
  }
  const key = readLocalKey(NETWORK);
  if (!key) throw new Error("No trading key — finish setup first.");
  const owner = (key.masterAddress ?? key.address) as `0x${string}`;

  const meta = await resolveSymbol(NETWORK, fund.spotSymbol);
  if (!meta) throw new Error(`Market ${fund.spotSymbol} not found on SoDEX.`);

  const { aid } = await spotUsdcBalance(owner);
  if (!aid) throw new Error("No SoDEX spot account for this wallet.");

  const isBuy = side === "buy";
  if (isBuy && !input.funds) throw new Error("No amount.");
  if (!isBuy && !input.quantity) throw new Error("No amount.");

  const clOrdID = `helix-wlth-${Math.random().toString(16).slice(2, 10)}`.slice(0, 36);
  const entry: SodexNewOrderEntry = {
    symbolID: meta.id,
    clOrdID,
    side: isBuy ? SodexSide.BUY : SodexSide.SELL,
    type: SodexOrderType.MARKET,
    timeInForce: SodexTimeInForce.IOC,
    ...(isBuy ? { funds: input.funds } : { quantity: input.quantity }),
  };

  const resp = await placeOrderBatch({
    network: NETWORK,
    apiKeyName: key.name || undefined,
    privateKey: key.privateKey,
    batch: { accountID: aid, orders: [entry] },
    market: "spot",
  });

  if (resp && typeof resp === "object" && (resp as { dryRun?: boolean }).dryRun) {
    return { kind: "dry_run", payload: (resp as { body?: unknown }).body };
  }
  const outcome = classifyOrderResult(resp);
  if (outcome.status === "ok") return { kind: "ok", orderID: outcome.orderID ?? null };
  if (outcome.status === "rejected") {
    return { kind: "rejected", reason: outcome.reason ?? "Order rejected." };
  }
  return { kind: "unconfirmed" };
}
