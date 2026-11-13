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
// ValueChain is SoDEX's own EVM chain — the chain the wallet must be ON to
// sign account-level actions (addAPIKey / builder-fee approval) whose EIP-712
// domain uses the ValueChain chain id. RPC + explorer from the ValueChain EVM
// docs; SOSO is the native gas token (18 decimals).
export const sodexMainnet = defineChain({
  id: 286623,
  name: "ValueChain",
  nativeCurrency: { name: "SOSO", symbol: "SOSO", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://mainnet.valuechain.xyz"] },
  },
  blockExplorers: {
    default: { name: "ValueScan", url: "https://main-scan.valuechain.xyz" },
  },
  testnet: false,
});

export const sodexTestnet = defineChain({
  id: 138565,
  name: "ValueChain Testnet",
  nativeCurrency: { name: "SOSO", symbol: "SOSO", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://testnet.valuechain.xyz"] },
  },
  blockExplorers: {
    default: { name: "ValueScan", url: "https://test-scan.valuechain.xyz" },
  },
  testnet: true,
});

/**
 * EIP-3085 params for `wallet_addEthereumChain` — used to switch (or add) the
 * user's wallet to ValueChain before signing account-level actions.
 */
export function valueChainAddParams(network: SodexNetwork): {
  chainId: string;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls: string[];
} {
  const isMain = network === "mainnet";
  return {
    chainId: `0x${SODEX_NETWORKS[network].chainId.toString(16)}`,
    chainName: isMain ? "ValueChain" : "ValueChain Testnet",
    nativeCurrency: { name: "SOSO", symbol: "SOSO", decimals: 18 },
    rpcUrls: [
      isMain ? "https://mainnet.valuechain.xyz" : "https://testnet.valuechain.xyz",
    ],
    blockExplorerUrls: [
      isMain
        ? "https://main-scan.valuechain.xyz"
        : "https://test-scan.valuechain.xyz",
    ],
  };
}

// ── Builder code (fee sharing) ─────────────────────────────────────────────
// SoDEX "builder codes" let the app that routes an order earn a fee on the
// fill. A builder is just a funded SoDEX account — no registration — and its
// numeric account id (`aid`) IS the builder id; it must hold ≥100 vUSDC in
// BOTH the spot and perps engines to be eligible. Set Helix's builder id below
// (via env, or edit the fallback) once that account is funded. `0` = disabled:
// no `builder` field is added to orders, so behaviour is identical to before.
//
// Fee is in TENTHS OF A BASIS POINT (10 = 1 bp = 0.01%). The charged rate is
// min(user-approved max, engine cap) — spot caps at 2000 (2%), perps at 200
// (0.2%) — and is 0 until the user approves it, so routing is always safe.
const BUILDER_ID: Record<SodexNetwork, number> = {
  // Helix's funded builder account (Daily-Up) — wallet
  // 0xEeb813d8C68CdC2Dfcecc3c7ECa71f17c830902d, aid 8409. Public account id,
  // so hardcoded as the default; NEXT_PUBLIC_SODEX_BUILDER_ID_MAINNET overrides.
  mainnet: Number(process.env.NEXT_PUBLIC_SODEX_BUILDER_ID_MAINNET ?? "8409") || 8409,
  testnet: Number(process.env.NEXT_PUBLIC_SODEX_BUILDER_ID_TESTNET ?? "0") || 0,
};
// 30 tenths-of-a-bp = 3 bp = 0.03% (was 20 = 2 bp; before that 10 = 1 bp).
// Raised 2026-11-13.
// NOTE: this is also the max-fee rate requested in approveBuilder(), so users
// who approved at the old 2 bp ceiling must RE-APPROVE before their orders will
// route at 3 bp (SoDEX rejects a builder fee above the approved max).
const BUILDER_FEE_TENTHS_BP =
  Number(process.env.NEXT_PUBLIC_SODEX_BUILDER_FEE ?? "30") || 30;

export interface SodexBuilderCode {
  /** Helix's SoDEX builder account id. */
  id: number;
  /** Requested fee rate, tenths of a basis point. */
  fee: number;
}

/**
 * Helix's builder code for a network, or null when unconfigured (feature off).
 * Fee is clamped to the lower (perps) engine cap so one value is safe on both
 * engines; spot would allow up to 2%, but we keep it uniform + modest.
 */
export function getBuilderCode(network: SodexNetwork): SodexBuilderCode | null {
  const id = BUILDER_ID[network];
  if (!id || id <= 0) return null;
  const fee = Math.max(1, Math.min(200, Math.round(BUILDER_FEE_TENTHS_BP)));
  return { id, fee };
}

/** The default network we open with — testnet keeps judges risk-free. */
export const DEFAULT_NETWORK: SodexNetwork = "testnet";

/**
 * Storage key used by the client component that remembers which
 * network the user picked. We read/write through localStorage so the
 * server side never sees it.
 */
export const NETWORK_STORAGE_KEY = "helix.sodex.network";
