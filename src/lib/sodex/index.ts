/**
 * Public SoDEX surface — read-only market data only for now.
 *
 * Trading endpoints (place/cancel orders, balances) require EIP-712
 * signatures and will be added when we wire real execution. Paper trading
 * uses the market data here + simulated fill logic.
 */

export * from "./client";
export * from "./types";
export * as Market from "./market";
