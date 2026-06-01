/**
 * SoDEX network configuration.
 *
 * SoDEX runs its own EVM-compatible chain with two networks. Every
 * EIP-712 signature we produce must use the right chainId or the
 * gateway will reject it with "invalid signature".
 *
 * Gateway URLs are taken from the SoDEX trading-api docs:
 *   https://sodex.com/documentation/trading-api/trading-api
 */

import { defineChain } from "viem";

export type SodexNetwork = "mainnet" | "testnet";

export interface SodexNetworkConfig {
  network: SodexNetwork;
  chainId: number;
  spotEndpoint: string;
  perpsEndpoint: string;
  spotWs: string;
  perpsWs: string;
  label: string;
  isLive: boolean;
}

export const SODEX_NETWORKS: Record<SodexNetwork, SodexNetworkConfig> = {
  mainnet: {
    network: "mainnet",
    chainId: 286623,
    spotEndpoint: "https://mainnet-gw.sodex.dev/api/v1/spot",
    perpsEndpoint: "https://mainnet-gw.sodex.dev/api/v1/perps",
    spotWs: "wss://mainnet-gw.sodex.dev/ws/spot",
    perpsWs: "wss://mainnet-gw.sodex.dev/ws/perps",
    label: "SoDEX Mainnet",
    isLive: true,
  },
  testnet: {
    network: "testnet",
    chainId: 138565,
    spotEndpoint: "https://testnet-gw.sodex.dev/api/v1/spot",
    perpsEndpoint: "https://testnet-gw.sodex.dev/api/v1/perps",
    spotWs: "wss://testnet-gw.sodex.dev/ws/spot",
    perpsWs: "wss://testnet-gw.sodex.dev/ws/perps",
    label: "SoDEX Testnet",
    isLive: false,
  },
};

/**
 * viem-format chain definitions. We register both so wagmi can switch
 * the user's wallet between them; SoDEX doesn't expose RPC URLs in its
 * public docs (the gateway abstracts execution), so we point at the
 * gateway's host for the rpcUrl — it isn't used for trading (we POST
 * via REST), only for wallet bookkeeping.
 */
export const sodexMainnet = defineChain({
  id: 286623,
  name: "SoDEX Mainnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://mainnet-gw.sodex.dev"] },
  },
  blockExplorers: {
    default: { name: "SoDEX", url: "https://sodex.com" },
  },
  testnet: false,
});

export const sodexTestnet = defineChain({
  id: 138565,
  name: "SoDEX Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://testnet-gw.sodex.dev"] },
  },
  blockExplorers: {
    default: { name: "SoDEX", url: "https://sodex.com" },
  },
  testnet: true,
});

/** The default network we open with — testnet keeps judges risk-free. */
export const DEFAULT_NETWORK: SodexNetwork = "testnet";

/**
 * Storage key used by the client component that remembers which
 * network the user picked. We read/write through localStorage so the
 * server side never sees it.
 */
export const NETWORK_STORAGE_KEY = "helix.sodex.network";
