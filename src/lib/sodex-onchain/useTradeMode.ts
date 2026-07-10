"use client";

/**
 * useTradeMode — the SINGLE source of truth for "is this browser set up
 * to trade live?".
 *
 * Readiness = a Helix SoDEX key is stored locally AND the safety-limits
 * disclaimer has been accepted. It deliberately does NOT depend on an
 * active wagmi/RainbowKit session: the wallet connection is only needed
 * once, during SETUP (to sign addAPIKey / self-heal the master address).
 * The persisted key + master address are what let ongoing trades work,
 * so ongoing "am I live?" must key off those — not the ephemeral session.
 *
 * Before this hook, the topbar badge read the stored key (→ "LIVE") while
 * the /signals panel read the wagmi session (→ "connect a wallet"), so
 * the two contradicted on screen. Everything now consumes this hook.
 */

import { useCallback, useEffect, useState } from "react";
import { readLocalKey, readSafetyLimits } from "./local-keys";
import type { SodexNetwork } from "./chains";

export interface TradeModeState {
  /** "live" once ready; "demo" otherwise. */
  mode: "live" | "demo";
  /** Key present AND disclaimer accepted — Execute Live is enabled. */
  ready: boolean;
  hasKey: boolean;
  acceptedDisclaimer: boolean;
  /** Master wallet address (preferred) or the key's own address. */
  address: `0x${string}` | null;
  /** SoDEX API-key name, or "(burner)" for a keyed burner, or null. */
  keyName: string | null;
  /** True until the first client read completes (avoids SSR flash). */
  loading: boolean;
}

const INITIAL: TradeModeState = {
  mode: "demo",
  ready: false,
  hasKey: false,
  acceptedDisclaimer: false,
  address: null,
  keyName: null,
  loading: true,
};

export function useTradeMode(
  network: SodexNetwork = "mainnet",
): TradeModeState {
  const [state, setState] = useState<TradeModeState>(INITIAL);

  const refresh = useCallback(() => {
    const key = readLocalKey(network);
    const limits = readSafetyLimits(network);
    const hasKey = !!key;
    const acceptedDisclaimer = limits.acceptedDisclaimer;
    const ready = hasKey && acceptedDisclaimer;
    setState({
      mode: ready ? "live" : "demo",
      ready,
      hasKey,
      acceptedDisclaimer,
      address: key?.masterAddress ?? key?.address ?? null,
      keyName: key ? key.name || "(burner)" : null,
      loading: false,
    });
  }, [network]);

  useEffect(() => {
    refresh();
    // storage events fire cross-tab; the interval catches same-tab changes.
    window.addEventListener("storage", refresh);
    const t = setInterval(refresh, 5000);
    return () => {
      window.removeEventListener("storage", refresh);
      clearInterval(t);
    };
  }, [refresh]);

  return state;
}
