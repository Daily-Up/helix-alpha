/**
 * Public surface of the SoDEX on-chain client. Browser-only — no
 * server-side imports allowed (uses window.localStorage + wallet
 * RPC).
 */

export * from "./chains";
export * from "./types";
export * from "./signing";
export * from "./client";
export * from "./local-keys";
