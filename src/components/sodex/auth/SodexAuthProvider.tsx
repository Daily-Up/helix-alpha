"use client";

/**
 * SodexAuthProvider — the ONE source of truth for "is this browser set up to
 * trade live on SoDEX". Mounted once at the app root; every page reads it via
 * useSodexAuth(). It owns:
 *   • wallet connection + the raw EIP-1193 provider (from the wagmi connector)
 *   • the wallet's current chain (ValueChain?) — read live, not from storage
 *   • SoDEX account existence (+ accountID)
 *   • the Helix trading key (+ expiry) — only the secret lives in localStorage
 *   • builder-fee approval status (read from SoDEX, not assumed)
 *   • one-time risk acceptance
 * and derives `ready` + the first-incomplete `step`. All setup actions reuse
 * the existing signing functions (addApiKey, approveBuilderFee, revokeApiKey,
 * ensureWalletOnSodexChain) — no new signing code.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAccount, useConnect, useDisconnect, type Connector } from "wagmi";
import { SODEX_NETWORKS, getBuilderCode } from "@/lib/sodex-onchain/chains";
import type { Eip1193Provider } from "@/lib/sodex-onchain/signing";
import {
  getAccountState,
  getBuilderApproval,
  addApiKey as sodexAddApiKey,
  approveBuilderFee as sodexApproveBuilderFee,
  revokeApiKey as sodexRevokeApiKey,
  ensureWalletOnSodexChain,
} from "@/lib/sodex-onchain/client";
import {
  readLocalKey,
  writeLocalKey,
  clearLocalKey,
  mintNewApiKey,
  suggestKeyName,
  localKeyExpiry,
  readDisclaimerAccepted,
  writeDisclaimerAccepted,
  type StoredApiKey,
  type KeyExpiry,
} from "@/lib/sodex-onchain/local-keys";
import { SetupModal } from "./SetupModal";

const NETWORK = "mainnet" as const;
const SODEX_CHAIN_ID = SODEX_NETWORKS[NETWORK].chainId;

export type AuthStep = "wallet" | "network" | "key" | "builder" | "done";

export interface SodexAuthValue {
  // ── raw state ──
  address: `0x${string}` | null;
  isConnected: boolean;
  provider: Eip1193Provider | null;
  walletChainId: number | null;
  accountID: number | null;
  hasAccount: boolean;
  key: StoredApiKey | null;
  keyExpiry: KeyExpiry | null;
  builderApproved: boolean;
  builderFeeRate: number | null;
  disclaimerAccepted: boolean;
  // ── derived ──
  onChain: boolean;
  ready: boolean;
  loading: boolean;
  step: AuthStep;
  // ── modal / menu ──
  modalOpen: boolean;
  menuOpen: boolean;
  openSetup: (onReady?: () => void) => void;
  closeModal: () => void;
  setMenuOpen: (b: boolean) => void;
  // ── wallet connect (step 1) ──
  connectors: readonly Connector[];
  connectWith: (c: Connector) => Promise<void>;
  // ── setup actions ──
  refresh: () => Promise<void>;
  switchChain: () => Promise<void>;
  generateKey: () => Promise<void>;
  approveBuilder: () => Promise<void>;
  acceptDisclaimer: () => void;
  revokeKey: (name: string) => Promise<void>;
  disconnect: (alsoRevoke: boolean) => Promise<void>;
  // ── transient ──
  busy: string | null;
  error: string | null;
  clearError: () => void;
}

const Ctx = createContext<SodexAuthValue | null>(null);

export function useSodexAuth(): SodexAuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSodexAuth must be used within SodexAuthProvider");
  return v;
}

function isUnregistered(user: string | undefined, aid: number): boolean {
  return (
    !aid ||
    aid === 0 ||
    user === "0x0000000000000000000000000000000000000000"
  );
}

export function SodexAuthProvider({ children }: { children: React.ReactNode }) {
  const { address: wagmiAddress, isConnected, connector } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const address = (wagmiAddress ?? null) as `0x${string}` | null;

  const [provider, setProvider] = useState<Eip1193Provider | null>(null);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [accountID, setAccountID] = useState<number | null>(null);
  const [hasAccount, setHasAccount] = useState(false);
  const [key, setKey] = useState<StoredApiKey | null>(null);
  const [builderApproved, setBuilderApproved] = useState(false);
  const [builderFeeRate, setBuilderFeeRate] = useState<number | null>(null);
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const onReadyRef = useRef<(() => void) | null>(null);

  // Raw EIP-1193 provider straight from the connector (NOT wagmi's wallet
  // client — that enforces a chainId match that would force a wallet switch
  // for signing; we sign SoDEX typed-data on any chain).
  useEffect(() => {
    let cancelled = false;
    if (!connector) {
      setProvider(null);
      return;
    }
    (async () => {
      try {
        const raw = (await connector.getProvider()) as Eip1193Provider;
        if (!cancelled) setProvider(raw);
      } catch {
        if (!cancelled) setProvider(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connector]);

  const keyExpiry = useMemo(() => (key ? localKeyExpiry(key) : null), [key]);

  // Re-detect everything from the wallet + SoDEX. Never trusts localStorage
  // for status — only the key secret comes from there.
  const refresh = useCallback(async () => {
    setDisclaimerAccepted(readDisclaimerAccepted(NETWORK));

    // Local key: drop it if a different master wallet is connected.
    const stored = readLocalKey(NETWORK);
    let validKey = stored;
    if (
      stored?.masterAddress &&
      address &&
      stored.masterAddress.toLowerCase() !== address.toLowerCase()
    ) {
      clearLocalKey(NETWORK);
      validKey = null;
    }
    const exp = validKey ? localKeyExpiry(validKey) : null;
    if (exp?.state === "expired") validKey = null;
    setKey(validKey);

    if (!address) {
      setWalletChainId(null);
      setAccountID(null);
      setHasAccount(false);
      setBuilderApproved(false);
      setBuilderFeeRate(null);
      setLoading(false);
      return;
    }

    // Wallet chain (live).
    if (provider) {
      try {
        const cid = (await provider.request({
          method: "eth_chainId",
          params: [],
        })) as string;
        setWalletChainId(parseInt(cid, 16));
      } catch {
        setWalletChainId(null);
      }
    }

    // Account + builder approval, in parallel (both public reads).
    const [acctRes, builderRes] = await Promise.allSettled([
      getAccountState(NETWORK, address),
      getBuilderApproval(NETWORK, address),
    ]);
    if (acctRes.status === "fulfilled") {
      const s = acctRes.value;
      const aid = Number(s.aid) || 0;
      setAccountID(aid);
      setHasAccount(!isUnregistered(s.user, aid));
    }
    if (builderRes.status === "fulfilled") {
      setBuilderApproved(builderRes.value.approved);
      setBuilderFeeRate(builderRes.value.feeRate);
    }
    setLoading(false);
  }, [address, provider]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-detect on wallet chain / account change. The raw injected provider has
  // EIP-1193 events, but the Eip1193Provider type only declares `request`.
  useEffect(() => {
    const p = provider as
      | (Eip1193Provider & {
          on?: (ev: string, cb: (...a: unknown[]) => void) => void;
          removeListener?: (ev: string, cb: (...a: unknown[]) => void) => void;
        })
      | null;
    if (!p || typeof p.on !== "function") return;
    const onChange = () => {
      refresh();
    };
    p.on("chainChanged", onChange);
    p.on("accountsChanged", onChange);
    return () => {
      p.removeListener?.("chainChanged", onChange);
      p.removeListener?.("accountsChanged", onChange);
    };
  }, [provider, refresh]);

  // ── derived ──
  const onChain = walletChainId === SODEX_CHAIN_ID;
  const step: AuthStep =
    !isConnected || !address
      ? "wallet"
      : !onChain || !hasAccount
        ? "network"
        : !key
          ? "key"
          : !builderApproved
            ? "builder"
            : "done";
  const ready = step === "done" && disclaimerAccepted;

  // Fire the "return to what you were doing" callback once ready after setup.
  useEffect(() => {
    if (ready && modalOpen && onReadyRef.current) {
      const cb = onReadyRef.current;
      onReadyRef.current = null;
      setModalOpen(false);
      cb();
    }
  }, [ready, modalOpen]);

  // ── actions ──
  const openSetup = useCallback((onReady?: () => void) => {
    onReadyRef.current = onReady ?? null;
    setError(null);
    setMenuOpen(false);
    setModalOpen(true);
  }, []);
  const closeModal = useCallback(() => {
    onReadyRef.current = null;
    setModalOpen(false);
  }, []);
  const clearError = useCallback(() => setError(null), []);

  const connectWith = useCallback(
    async (c: Connector) => {
      setBusy("wallet");
      setError(null);
      try {
        await connectAsync({ connector: c });
      } catch (e) {
        const m = (e as Error).message ?? "";
        if (!/reject|denied|cancel/i.test(m)) setError(m);
      } finally {
        setBusy(null);
      }
    },
    [connectAsync],
  );

  const switchChain = useCallback(async () => {
    if (!provider) return;
    setBusy("network");
    setError(null);
    try {
      await ensureWalletOnSodexChain(provider, NETWORK);
      await refresh();
    } catch (e) {
      const m = (e as Error).message ?? "";
      if (!/reject|denied|cancel/i.test(m)) setError(m);
    } finally {
      setBusy(null);
    }
  }, [provider, refresh]);

  const generateKey = useCallback(async () => {
    if (!address || !provider) {
      setError("Wallet not connected.");
      return;
    }
    if (!accountID) {
      setError("No SoDEX account yet — deposit on SoDEX first.");
      return;
    }
    setBusy("key");
    setError(null);
    try {
      const next = mintNewApiKey(suggestKeyName());
      next.masterAddress = address;
      await sodexAddApiKey({
        network: NETWORK,
        provider,
        account: address,
        accountID,
        name: next.name,
        publicKey: next.address,
      });
      writeLocalKey(NETWORK, next);
      setKey(next);
    } catch (e) {
      const m = (e as Error).message ?? "";
      if (!/reject|denied|cancel/i.test(m)) setError(`Couldn't create a key: ${m}`);
    } finally {
      setBusy(null);
    }
  }, [address, provider, accountID]);

  const approveBuilder = useCallback(async () => {
    if (!address || !provider || !accountID) return;
    const builder = getBuilderCode(NETWORK);
    if (!builder) {
      setError("Builder fee isn't configured.");
      return;
    }
    setBusy("builder");
    setError(null);
    try {
      await sodexApproveBuilderFee({
        network: NETWORK,
        provider,
        account: address,
        accountID,
        builderID: builder.id,
        maxFeeRate: builder.fee,
      });
      await refresh();
    } catch (e) {
      const m = (e as Error).message ?? "";
      if (!/reject|denied|cancel/i.test(m))
        setError(`Couldn't approve the builder fee: ${m}`);
    } finally {
      setBusy(null);
    }
  }, [address, provider, accountID, refresh]);

  const acceptDisclaimer = useCallback(() => {
    writeDisclaimerAccepted(NETWORK, true);
    setDisclaimerAccepted(true);
  }, []);

  const revokeKey = useCallback(
    async (name: string) => {
      if (!address || !provider || !accountID) return;
      setBusy(`revoke:${name}`);
      setError(null);
      try {
        await sodexRevokeApiKey({
          network: NETWORK,
          provider,
          account: address,
          accountID,
          name,
        });
        if (key?.name === name) {
          clearLocalKey(NETWORK);
          setKey(null);
        }
        await refresh();
      } catch (e) {
        setError(`Couldn't revoke "${name}": ${(e as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [address, provider, accountID, key?.name, refresh],
  );

  const disconnect = useCallback(
    async (alsoRevoke: boolean) => {
      const stored = readLocalKey(NETWORK);
      if (alsoRevoke && stored?.name && address && provider && accountID) {
        try {
          await sodexRevokeApiKey({
            network: NETWORK,
            provider,
            account: address,
            accountID,
            name: stored.name,
          });
        } catch {
          /* non-fatal — the local key is cleared regardless */
        }
      }
      clearLocalKey(NETWORK);
      setKey(null);
      setMenuOpen(false);
      try {
        await disconnectAsync();
      } catch {
        /* ignore */
      }
    },
    [address, provider, accountID, disconnectAsync],
  );

  const value: SodexAuthValue = {
    address,
    isConnected,
    provider,
    walletChainId,
    accountID,
    hasAccount,
    key,
    keyExpiry,
    builderApproved,
    builderFeeRate,
    disclaimerAccepted,
    onChain,
    ready,
    loading,
    step,
    modalOpen,
    menuOpen,
    openSetup,
    closeModal,
    setMenuOpen,
    connectors,
    connectWith,
    refresh,
    switchChain,
    generateKey,
    approveBuilder,
    acceptDisclaimer,
    revokeKey,
    disconnect,
    busy,
    error,
    clearError,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      <SetupModal />
    </Ctx.Provider>
  );
}
