"use client";

/**
 * The full "Connect SoDEX" wizard component.
 *
 * Renders a wallet-connect button (via RainbowKit), then once the
 * wallet is connected, walks the user through:
 *
 *   1. Picking the SoDEX network (testnet by default)
 *   2. Loading the account state (account ID + balances)
 *   3. Listing API keys already registered on SoDEX for this wallet
 *   4. Generating a fresh Helix-scoped API key (master-wallet signed)
 *   5. Revoking any key (master-wallet signed)
 *   6. Editing safety limits stored in localStorage
 *
 * Helix's server is never touched by this page — every byte goes
 * directly to mainnet-gw / testnet-gw, signed in-browser.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  useAccount,
  useChainId,
  useSwitchChain,
  useWalletClient,
} from "wagmi";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import {
  DEFAULT_NETWORK,
  NETWORK_STORAGE_KEY,
  SODEX_NETWORKS,
  sodexMainnet,
  sodexTestnet,
  type SodexNetwork,
} from "@/lib/sodex-onchain/chains";
import {
  addApiKey as sodexAddApiKey,
  getAccountState,
  listApiKeys,
  revokeApiKey as sodexRevokeApiKey,
} from "@/lib/sodex-onchain/client";
import {
  clearLocalKey,
  mintNewApiKey,
  readLocalKey,
  readSafetyLimits,
  suggestKeyName,
  writeLocalKey,
  writeSafetyLimits,
  type SafetyLimits,
  type StoredApiKey,
} from "@/lib/sodex-onchain/local-keys";
import type {
  SodexAccountState,
  SodexApiKeyRow,
} from "@/lib/sodex-onchain/types";

export function ConnectSodexPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { data: walletClient } = useWalletClient();

  // ── Network state ──────────────────────────────────────────────
  const [network, setNetwork] = useState<SodexNetwork>(DEFAULT_NETWORK);
  // Restore network preference on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(NETWORK_STORAGE_KEY);
    if (stored === "mainnet" || stored === "testnet") setNetwork(stored);
  }, []);
  const setNetworkAndStore = useCallback((n: SodexNetwork) => {
    setNetwork(n);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(NETWORK_STORAGE_KEY, n);
    }
  }, []);

  const requiredChainId = SODEX_NETWORKS[network].chainId;
  const onWrongChain = isConnected && chainId !== requiredChainId;

  // ── Data fetches (account state + listed API keys) ─────────────
  const [accountState, setAccountState] = useState<SodexAccountState | null>(
    null,
  );
  const [remoteKeys, setRemoteKeys] = useState<SodexApiKeyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAccount = useCallback(async () => {
    if (!isConnected || !address) {
      setAccountState(null);
      setRemoteKeys([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [state, keys] = await Promise.all([
        getAccountState(network, address),
        listApiKeys(network, address),
      ]);
      setAccountState(state);
      setRemoteKeys(keys);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [isConnected, address, network]);

  useEffect(() => {
    refreshAccount();
  }, [refreshAccount]);

  // ── Local key + safety limits ──────────────────────────────────
  const localKey: StoredApiKey | null = useMemo(() => {
    if (!address) return null;
    return readLocalKey(network, address);
  }, [address, network, remoteKeys]); // re-read after a refresh

  const [limits, setLimits] = useState<SafetyLimits>({
    maxPositionUsd: 10,
    maxDailyTrades: 3,
    acceptedDisclaimer: false,
  });
  useEffect(() => {
    if (!address) return;
    setLimits(readSafetyLimits(address));
  }, [address]);
  const saveLimits = useCallback(
    (next: SafetyLimits) => {
      if (!address) return;
      writeSafetyLimits(address, next);
      setLimits(next);
    },
    [address],
  );

  // ── Actions ────────────────────────────────────────────────────
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const onGenerateKey = useCallback(async () => {
    if (!isConnected || !address || !walletClient || !accountState) return;
    if (onWrongChain) {
      setError(`Switch your wallet to ${SODEX_NETWORKS[network].label} first.`);
      return;
    }
    setBusy("generate");
    setError(null);
    setActionMsg(null);
    try {
      const next = mintNewApiKey(suggestKeyName());
      await sodexAddApiKey({
        network,
        walletClient,
        account: address,
        accountID: accountState.aid,
        name: next.name,
        publicKey: next.address,
      });
      writeLocalKey(network, address, next);
      setActionMsg(`✓ Created API key "${next.name}" — saved in this browser only`);
      await refreshAccount();
    } catch (err) {
      setError(`Failed to add API key: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [
    isConnected,
    address,
    walletClient,
    accountState,
    onWrongChain,
    network,
    refreshAccount,
  ]);

  const onRevokeKey = useCallback(
    async (name: string) => {
      if (!isConnected || !address || !walletClient || !accountState) return;
      if (onWrongChain) {
        setError(`Switch your wallet to ${SODEX_NETWORKS[network].label} first.`);
        return;
      }
      if (!confirm(`Revoke API key "${name}"? This will disconnect Helix from your account.`))
        return;
      setBusy(`revoke:${name}`);
      setError(null);
      setActionMsg(null);
      try {
        await sodexRevokeApiKey({
          network,
          walletClient,
          account: address,
          accountID: accountState.aid,
          name,
        });
        // If we held the matching local private key, drop it.
        if (localKey?.name === name) clearLocalKey(network, address);
        setActionMsg(`✓ Revoked "${name}"`);
        await refreshAccount();
      } catch (err) {
        setError(`Failed to revoke: ${(err as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [
      isConnected,
      address,
      walletClient,
      accountState,
      onWrongChain,
      network,
      localKey?.name,
      refreshAccount,
    ],
  );

  const balanceLine = useMemo(() => {
    if (!accountState?.B || accountState.B.length === 0) return "no balances";
    return accountState.B.map((b) => `${b.t} ${b.a}`).join(" · ");
  }, [accountState]);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-fg">Connect SoDEX</h1>
        <p className="text-sm text-fg-muted">
          Trade live on SoDEX with your own wallet and your own funds.
          Helix never sees your master wallet&apos;s private key — it
          stays in your wallet (MetaMask, Phantom-EVM, etc.). API keys
          are generated locally in your browser and only their public
          address is registered with SoDEX.
        </p>
      </header>

      {/* Network picker */}
      <Card>
        <CardHeader>
          <CardTitle>1. Choose network</CardTitle>
          <span className="text-[11px] text-fg-dim">
            Testnet uses fake funds — recommended for trying it out.
          </span>
        </CardHeader>
        <CardBody>
          <div className="flex gap-2">
            {(["testnet", "mainnet"] as SodexNetwork[]).map((n) => (
              <button
                key={n}
                onClick={() => setNetworkAndStore(n)}
                className={cn(
                  "rounded border px-3 py-1.5 text-xs font-medium transition-colors",
                  network === n
                    ? "border-accent/40 bg-accent/15 text-accent-2"
                    : "border-line bg-surface text-fg-muted hover:border-line-2 hover:text-fg",
                )}
              >
                {SODEX_NETWORKS[n].label}
                {n === "testnet" ? " · safe" : ""}
              </button>
            ))}
            <span className="ml-auto self-center text-[11px] text-fg-dim">
              chainId {SODEX_NETWORKS[network].chainId}
            </span>
          </div>
        </CardBody>
      </Card>

      {/* Step 2 — wallet connect */}
      <Card>
        <CardHeader>
          <CardTitle>2. Connect your wallet</CardTitle>
          <span className="text-[11px] text-fg-dim">
            We never see your private key.
          </span>
        </CardHeader>
        <CardBody>
          <div className="flex items-center gap-3">
            <ConnectButton
              accountStatus="address"
              chainStatus="icon"
              showBalance={false}
            />
            {isConnected ? (
              <span className="text-xs text-fg-muted">
                connected as{" "}
                <span className="font-mono text-fg">
                  {address?.slice(0, 6)}…{address?.slice(-4)}
                </span>
              </span>
            ) : null}
            {onWrongChain ? (
              <button
                onClick={() =>
                  switchChain({
                    chainId:
                      network === "mainnet" ? sodexMainnet.id : sodexTestnet.id,
                  })
                }
                className="rounded border border-warning/40 bg-warning/15 px-2.5 py-1 text-xs text-warning hover:bg-warning/25"
              >
                Switch wallet to {SODEX_NETWORKS[network].label}
              </button>
            ) : null}
          </div>
        </CardBody>
      </Card>

      {/* Step 3 — account + keys */}
      {isConnected ? (
        <Card>
          <CardHeader>
            <CardTitle>3. Your SoDEX account</CardTitle>
            <span className="text-[11px] text-fg-dim">
              live data from {SODEX_NETWORKS[network].label}
            </span>
          </CardHeader>
          <CardBody>
            {loading ? (
              <div className="text-sm text-fg-muted">Loading…</div>
            ) : accountState ? (
              <div className="flex flex-col gap-2 text-sm">
                <div className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1 font-mono text-xs">
                  <span className="text-fg-dim">Account ID</span>
                  <span className="text-fg">{accountState.aid}</span>
                  <span className="text-fg-dim">Wallet</span>
                  <span className="text-fg">{accountState.user}</span>
                  <span className="text-fg-dim">Balances</span>
                  <span className="text-fg">{balanceLine}</span>
                </div>
                {accountState.B.length === 0 ? (
                  <div className="mt-2 rounded border border-warning/30 bg-warning/5 p-2 text-xs text-warning">
                    Your SoDEX account has no balance.{" "}
                    {network === "testnet" ? (
                      <>Grab testnet tokens from the SoDEX faucet to try execution.</>
                    ) : (
                      <>Deposit funds at sodex.com before placing live trades.</>
                    )}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="text-sm text-fg-muted">
                No account state — try refreshing.
              </div>
            )}
            {error ? (
              <div className="mt-3 rounded border border-negative/30 bg-negative/10 p-2 text-xs text-negative">
                {error}
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {/* Step 4 — Helix API keys */}
      {isConnected && accountState ? (
        <Card>
          <CardHeader>
            <CardTitle>4. Helix API keys</CardTitle>
            <span className="text-[11px] text-fg-dim">
              SoDEX allows up to 5 keys per account
            </span>
          </CardHeader>
          <CardBody className="!p-0">
            {remoteKeys.length === 0 ? (
              <div className="p-4 text-sm text-fg-muted">
                No API keys registered yet — generate one to enable live execution.
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {remoteKeys.map((k) => {
                  const isLocal = localKey?.name === k.name;
                  const isDefault = k.name === "default";
                  const isHelix = k.name.startsWith("helix-");
                  return (
                    <li
                      key={k.name}
                      className="grid grid-cols-[1fr_120px_120px] items-center gap-3 px-4 py-2 text-xs"
                    >
                      <div className="flex flex-col">
                        <span className="font-mono font-medium text-fg">
                          {k.name}
                        </span>
                        <span className="font-mono text-[10px] text-fg-dim">
                          {k.publicKey.slice(0, 10)}…{k.publicKey.slice(-6)}
                        </span>
                      </div>
                      <div className="flex flex-col items-start gap-0.5">
                        {isDefault ? (
                          <Badge tone="neutral">master key</Badge>
                        ) : isHelix ? (
                          <Badge tone="positive">helix</Badge>
                        ) : (
                          <Badge tone="neutral">external</Badge>
                        )}
                        {isLocal ? (
                          <span className="text-[10px] text-fg-dim">
                            ✓ secret in this browser
                          </span>
                        ) : null}
                      </div>
                      <div className="text-right">
                        {!isDefault ? (
                          <button
                            onClick={() => onRevokeKey(k.name)}
                            disabled={!!busy}
                            className="rounded border border-line px-2 py-0.5 text-[10px] text-fg-muted hover:border-negative/40 hover:text-negative"
                          >
                            {busy === `revoke:${k.name}`
                              ? "Revoking…"
                              : "Revoke"}
                          </button>
                        ) : (
                          <span className="text-[10px] text-fg-dim">
                            cannot revoke
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="flex items-center justify-between gap-3 border-t border-line p-3">
              <span className="text-[11px] text-fg-dim">
                Generating a new key opens MetaMask once to sign the
                addAPIKey action.
              </span>
              <button
                onClick={onGenerateKey}
                disabled={!!busy || remoteKeys.length >= 5 || onWrongChain}
                className={cn(
                  "rounded border px-3 py-1.5 text-xs font-medium transition-colors",
                  busy === "generate"
                    ? "cursor-wait border-line bg-surface-2 text-fg-dim"
                    : "border-accent/40 bg-accent/15 text-accent-2 hover:bg-accent/25",
                )}
              >
                {busy === "generate" ? "Generating…" : "+ Generate new key"}
              </button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* Step 5 — Safety limits */}
      {isConnected && localKey ? (
        <Card>
          <CardHeader>
            <CardTitle>5. Safety limits</CardTitle>
            <span className="text-[11px] text-fg-dim">
              Stored locally — Helix enforces these before submitting any
              order from this browser.
            </span>
          </CardHeader>
          <CardBody>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-fg-dim">Max position (USD)</span>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  value={limits.maxPositionUsd}
                  onChange={(e) =>
                    saveLimits({
                      ...limits,
                      maxPositionUsd: Number(e.target.value) || 0,
                    })
                  }
                  className="rounded border border-line bg-surface px-2 py-1 font-mono text-fg"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-fg-dim">Max daily trades</span>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={limits.maxDailyTrades}
                  onChange={(e) =>
                    saveLimits({
                      ...limits,
                      maxDailyTrades: Number(e.target.value) || 0,
                    })
                  }
                  className="rounded border border-line bg-surface px-2 py-1 font-mono text-fg"
                />
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={limits.acceptedDisclaimer}
                  onChange={(e) =>
                    saveLimits({
                      ...limits,
                      acceptedDisclaimer: e.target.checked,
                    })
                  }
                />
                <span className="text-fg-muted">
                  I understand Helix will execute trades on my SoDEX
                  account and I may lose money.
                </span>
              </label>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* Connected status banner */}
      {actionMsg ? (
        <div className="rounded border border-positive/30 bg-positive/5 px-3 py-2 text-xs text-positive">
          {actionMsg}
        </div>
      ) : null}

      {/* Live trade history */}
      {isConnected && address ? <MyTradesPanel wallet={address} /> : null}

      {/* Final summary */}
      {isConnected && localKey && limits.acceptedDisclaimer ? (
        <div className="rounded border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-accent">
          ✓ Ready to execute live trades on {SODEX_NETWORKS[network].label}.
          Live-execute buttons will appear on signal cards.
        </div>
      ) : null}
    </div>
  );
}

// ─── Live trade history panel ──────────────────────────────────────

interface ExecutedTradeView {
  id: string;
  user_wallet: string;
  signal_id: string | null;
  network: "mainnet" | "testnet";
  symbol: string;
  side: "buy" | "sell";
  size_usd: number | null;
  filled_price: number | null;
  filled_at: number;
  sodex_order_id: string | null;
  status: "submitted" | "filled" | "rejected";
  error: string | null;
}

function MyTradesPanel({ wallet }: { wallet: `0x${string}` }) {
  const [trades, setTrades] = useState<ExecutedTradeView[] | null>(null);
  const [tradesError, setTradesError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/sodex/my-trades?wallet=${wallet}&limit=25`,
      );
      const json = (await res.json()) as {
        ok: boolean;
        trades?: ExecutedTradeView[];
        error?: string;
      };
      if (!json.ok) {
        setTradesError(json.error ?? "load failed");
        return;
      }
      setTrades(json.trades ?? []);
      setTradesError(null);
    } catch (err) {
      setTradesError((err as Error).message);
    }
  }, [wallet]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>6. Your live trades</CardTitle>
        <span className="text-[11px] text-fg-dim">
          Every order this wallet has executed via Helix, on-chain audit only.
        </span>
      </CardHeader>
      <CardBody className="!p-0">
        {tradesError ? (
          <div className="p-3 text-xs text-negative">{tradesError}</div>
        ) : trades == null ? (
          <div className="p-3 text-xs text-fg-muted">Loading…</div>
        ) : trades.length === 0 ? (
          <div className="p-3 text-xs text-fg-muted">
            No live trades yet. Generate an API key, set safety limits,
            then click <strong>▶ Execute live</strong> on any signal.
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {trades.map((t) => (
              <li
                key={t.id}
                className="grid grid-cols-[80px_120px_1fr_60px_80px_100px] items-center gap-3 px-3 py-1.5 text-xs"
              >
                <Badge
                  tone={
                    t.status === "filled"
                      ? "positive"
                      : t.status === "rejected"
                        ? "negative"
                        : "neutral"
                  }
                >
                  {t.status}
                </Badge>
                <span className="font-mono text-fg">{t.symbol}</span>
                <span
                  className="font-mono text-[10px]"
                  style={{
                    color: t.side === "buy" ? "#5cc97a" : "#e06c66",
                  }}
                >
                  {t.side.toUpperCase()}
                </span>
                <span className="text-right text-fg-muted">
                  {t.size_usd != null ? `$${t.size_usd.toFixed(0)}` : "—"}
                </span>
                <Badge tone="neutral">{t.network}</Badge>
                <span className="text-right text-[10px] text-fg-dim">
                  {new Date(t.filled_at).toISOString().slice(11, 19)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
