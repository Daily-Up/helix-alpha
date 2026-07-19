/**
 * Shared types + enums for SoDEX trading.
 *
 * Numeric enums are taken verbatim from the SoDEX REST API v1 schema:
 *   side:         BUY=1, SELL=2
 *   orderType:    LIMIT=1, MARKET=2
 *   timeInForce:  GTC=1, FOK=2, IOC=3, GTX=4
 *   modifier:     NORMAL=1, STOP=2, BRACKET=3, ATTACHED_STOP=4
 *   positionSide: BOTH=1, LONG=2, SHORT=3
 *
 * SoDEX uses int32 codes on the wire, not strings, so we keep
 * matching const objects and use the int values directly when
 * constructing payloads.
 */

export const SodexSide = { BUY: 1, SELL: 2 } as const;
export const SodexOrderType = { LIMIT: 1, MARKET: 2 } as const;
export const SodexTimeInForce = { GTC: 1, FOK: 2, IOC: 3, GTX: 4 } as const;
export const SodexModifier = {
  NORMAL: 1,
  STOP: 2,
  BRACKET: 3,
  ATTACHED_STOP: 4,
} as const;
export const SodexPositionSide = { BOTH: 1, LONG: 2, SHORT: 3 } as const;

/** API-key Type field — observed value EVM=1 from listAPIKeys response. */
export const SodexApiKeyType = { EVM: 1 } as const;

export type SodexSideValue = (typeof SodexSide)[keyof typeof SodexSide];
export type SodexOrderTypeValue =
  (typeof SodexOrderType)[keyof typeof SodexOrderType];
export type SodexTifValue =
  (typeof SodexTimeInForce)[keyof typeof SodexTimeInForce];

/** Shape of an entry returned by listAPIKeys. */
export interface SodexApiKeyRow {
  name: string;
  /** Wire form is the string "EVM"; numeric on the AddAPIKey wire is 1. */
  type: string;
  publicKey: `0x${string}`;
  /** 0 means no expiry. */
  expiresAt: number;
}

/** Spot account state, as returned by GET /spot/accounts/{address}/state. */
export interface SodexAccountState {
  user: `0x${string}`;
  /** Account ID — required as `accountID` in every signed action. */
  aid: number;
  uid: number;
  /** Balances. `i` = asset id, `a` = symbol, `t` = total, `l` = locked. */
  B: Array<{ i: number; a: string; t: string; l: string }>;
  /** Open orders summary — null if none. */
  O: unknown;
}

/**
 * Perps account state, as returned by GET /perps/accounts/{address}/state.
 *
 * Carries the same identity fields as spot (`aid`, `uid`, `user`) plus
 * margin / position bookkeeping that doesn't exist on spot. The wallet
 * may have a spot account but no perps account (or vice versa); when
 * absent the gateway returns the zero-state envelope (`aid:0`,
 * `user:0x00…00`, empty arrays) — same convention as spot.
 */
export interface SodexPerpsAccountState {
  user: `0x${string}`;
  aid: number;
  uid: number;
  /** Account value — collateral + unrealised PnL on open positions. */
  av: string;
  /** Available margin (free collateral after open positions + orders). */
  am: string;
  /** Initial margin held against open positions. */
  ami: string;
  /** Withdrawable margin. */
  amw: string;
  /** Initial / current / open-order margin breakdown. */
  im: string;
  cm: string;
  oim: string;
  ocm: string;
  /**
   * Balances. NOTE: perps entries use `wb` (wallet balance) + `aw`
   * (available), NOT the spot `t`/`l` shape — reading `t` here yields 0.
   */
  B: Array<{ i: number; a: string; wb: string; aw?: string; am?: string }>;
  /** Open positions. sz is signed (positive long / negative short / 0 closed). */
  P: Array<{
    i: number;
    s: string;
    sz: string;
    ep: string;
    ps: number;
    cr?: string;
    m?: number;
  }>;
  /** Open orders. */
  O: unknown[];
  /** Subaccounts. */
  S: unknown[];
}

/** One outgoing order entry on a batch order placement. */
export interface SodexNewOrderEntry {
  symbolID: number;
  clOrdID: string;
  side: SodexSideValue;
  type: SodexOrderTypeValue;
  timeInForce: SodexTifValue;
  /** DecimalString — always a string, not a number. */
  price?: string;
  /** DecimalString. Exactly one of {quantity, funds} on MARKET orders;
   *  SoDEX rejects with "quantity and funds cannot be set at the
   *  same time" if both are present. */
  quantity?: string;
  /** DecimalString — for MARKET BUY orders specifying USD spend
   *  instead of base-asset size. Mutually exclusive with `quantity`. */
  funds?: string;
  /** Required on perps; optional/ignored on spot. */
  modifier?: number;
  /** Trigger price for STOP / take-profit orders (DecimalString). */
  stopPrice?: string;
  /** Stop-order variant (SL vs TP). Enum values not published — test. */
  stopType?: number;
  /** Trigger reference (mark / last / index). Enum not published — test. */
  triggerType?: number;
  reduceOnly?: boolean;
  positionSide?: number;
}

export interface SodexNewOrderBatch {
  accountID: number;
  orders: SodexNewOrderEntry[];
}

/**
 * Inner params for an addAPIKey action. Type is the int32 enum
 * (EVM = 1). ExpiresAt is unix-seconds; 0 means never.
 */
export interface SodexAddApiKeyParams {
  accountID: number;
  type: number;
  name: string;
  publicKey: `0x${string}`;
  expiresAt?: number;
}

export interface SodexRevokeApiKeyParams {
  accountID: number;
  name: string;
}

/**
 * The envelope we sign over (per docs: signing payload is the full
 * action object, HTTP body is the inner params only).
 */
export interface SodexAction<P = unknown> {
  type: string;
  params: P;
}

/** Helix-side record of one executed trade — for the audit log. */
export interface ExecutedTrade {
  trade_id: string;
  user_wallet: `0x${string}`;
  signal_id: string | null;
  network: "mainnet" | "testnet";
  symbol: string;
  side: "buy" | "sell";
  size_usd: number;
  filled_price: number | null;
  filled_at: number;
  sodex_order_id: string | null;
  status: "submitted" | "filled" | "rejected";
  error: string | null;
}
