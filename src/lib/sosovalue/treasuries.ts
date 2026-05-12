/**
 * SoSoValue BTC Treasuries endpoints (5.x).
 *
 * Public companies that hold BTC on balance sheet (MSTR, MARA, RIOT,
 * Metaplanet, etc.). The `/purchase-history` endpoint is the gold —
 * concrete, dated, named-quantity BTC accumulation events that drive
 * corporate treasury news. Wires into the Daily Briefing as a hard-fact
 * input alongside ETF flows and pending signals.
 *
 * Types verified against the live API via
 *   scripts/inspect-btc-treasuries.ts
 * The old hand-typed shape (btc_holdings, avg_purchase_price, etc.)
 * was wrong — those fields don't exist. Real fields below.
 */

import { sosoGet } from "./client";
import type { BtcTreasuryCompany, BtcTreasuryPurchase } from "./types";

// Re-export verified types under shorter aliases for back-compat with
// the namespace import (Treasuries.BTCTreasuryCompany etc).
export type BTCTreasuryCompany = BtcTreasuryCompany;
export type BTCPurchaseRecord = BtcTreasuryPurchase;

/** GET /btc-treasuries — all tracked companies (~56 as of May 2026). */
export function getBTCTreasuries(): Promise<BTCTreasuryCompany[]> {
  return sosoGet<BTCTreasuryCompany[]>("/btc-treasuries");
}

/**
 * GET /btc-treasuries/{ticker}/purchase-history
 *
 * Returns purchase events newest-first. The API caps each page at 50;
 * pass page>1 to walk further back. Most companies have <50 events
 * total so a single call typically suffices.
 */
export function getBTCPurchaseHistory(
  ticker: string,
  query?: { page?: number; page_size?: number },
): Promise<BTCPurchaseRecord[]> {
  return sosoGet<BTCPurchaseRecord[]>(
    `/btc-treasuries/${encodeURIComponent(ticker)}/purchase-history`,
    { query },
  );
}
