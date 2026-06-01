"use client";

/**
 * Web3 provider stack: wagmi + TanStack Query + RainbowKit.
 *
 * Wraps the whole app so any client component can use the wagmi
 * hooks (useAccount, useSignTypedData, etc.) and can render a
 * "Connect Wallet" button via RainbowKit.
 *
 * We register both SoDEX networks (mainnet + testnet) as wagmi
 * chains so the wallet can switch between them on demand. The
 * default chain is the testnet — judging mode keeps people safe.
 */

import { useState } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RainbowKitProvider,
  darkTheme,
  getDefaultConfig,
} from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";

import { sodexMainnet, sodexTestnet } from "@/lib/sodex-onchain/chains";

// A throwaway WalletConnect project ID. For a buildathon demo we
// don't need a real one — wagmi will use injected connectors
// (MetaMask, Phantom-EVM, etc.) which don't require a project ID.
// If you want WalletConnect-style mobile pairing, swap this for your
// own project ID from https://cloud.walletconnect.com.
const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "helix-buildathon-demo";

// Use RainbowKit's `getDefaultConfig` so we pick up the standard
// connector list (MetaMask, Coinbase, Rainbow, WalletConnect,
// injected fallback) without manually wiring each one.
const wagmiConfig = getDefaultConfig({
  appName: "Helix",
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: [sodexTestnet, sodexMainnet],
  transports: {
    [sodexTestnet.id]: http(),
    [sodexMainnet.id]: http(),
  },
  // SSR for App Router.
  ssr: true,
});

// Silence the "createConfig is unused" lint warning — keep import in
// case we need to compose a manual config later.
void createConfig;

export function Web3Provider({ children }: { children: React.ReactNode }) {
  // Construct the query client once, not per render.
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: "#d97757",
            accentColorForeground: "#0b0b0e",
            borderRadius: "small",
            fontStack: "system",
          })}
          modalSize="compact"
          initialChain={sodexTestnet.id}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
