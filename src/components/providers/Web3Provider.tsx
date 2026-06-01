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
import { WagmiProvider, http } from "wagmi";
import { mainnet } from "wagmi/chains";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RainbowKitProvider,
  darkTheme,
  getDefaultConfig,
} from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";

/**
 * Wagmi + RainbowKit provider.
 *
 * IMPORTANT: SoDEX is NOT registered as a wagmi chain here.
 * Registering it would force RainbowKit to prompt the user's
 * wallet (MetaMask, Rabby, …) to "Add Custom Network" with the
 * SoDEX RPC URL — which is wrong, because:
 *
 *   1. SoDEX trades are NOT on-chain transactions sent through an
 *      EVM RPC. They are REST POSTs to mainnet-gw / testnet-gw,
 *      authenticated by EIP-712 signatures.
 *   2. EIP-712 typed-data signing works regardless of which chain
 *      the wallet is currently connected to — the SoDEX chainId
 *      lives inside the signed payload, not the wallet network.
 *
 * So we register only Ethereum mainnet (any well-known chain works)
 * to keep wagmi happy. The wallet never has to switch.
 */

const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "helix-buildathon-demo";

const wagmiConfig = getDefaultConfig({
  appName: "Helix",
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: [mainnet],
  transports: { [mainnet.id]: http() },
  ssr: true,
});

export function Web3Provider({ children }: { children: React.ReactNode }) {
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
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
