"use client";

/**
 * /settings/connect-sodex.
 *
 * Two-track UX:
 *
 *   • Testnet  — burner-wallet flow. Click "Generate burner" →
 *     browser mints a fresh keypair → user funds it from the SoDEX
 *     faucet. The wallet IS the trading identity. No MetaMask, no
 *     addAPIKey. This matches how SoDEX testnet actually works.
 *
 *   • Mainnet  — master + API-key flow. Connect MetaMask → mint a
 *     new keypair locally → sign `addAPIKey` so SoDEX registers the
 *     public address → store the private key in the browser. Orders
 *     are signed with the API key (revocable any time from this
 *     page or from sodex.com). Master wallet stays cold; only used
 *     for setup + revocation.
 *
 * In both flows the private key lives ONLY in browser localStorage.
 * Helix's server never sees it and is not in the critical path of a
 * trade — orders go straight from the browser to mainnet-gw /
 * testnet-gw via CORS-open direct fetches.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import type { Eip1193Provider } from "@/lib/sodex-onchain/signing";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import {
  SODEX_NETWORKS,
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
  // Mainnet-only. SoDEX testnet was scoped out — its faucet doesn't
  // credit fresh addresses without a manual bootstrap on
  // testnet.sodex.com (the burner has no testnet ETH to call the
  // deposit portal). The SodexNetwork type is retained for the
  // executed_trades audit log so we can re-enable testnet later if
  // SoDEX adds an account-bootstrap API.
  const network: SodexNetwork = "mainnet";

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-fg">Connect SoDEX</h1>
        <p className="text-sm text-fg-muted">
          Trade live on SoDEX mainnet with your own wallet and your own
          funds. Helix never sees a private key — your master wallet
          signs addAPIKey once, and the resulting Helix-scoped key
          stays in your browser. Revoke any time.
        </p>
      </header>

      <MasterKeyFlow network={network} />
    </div>
  );
}

// ─── Unified flow: master wallet + Helix API key (both networks) ────

function MasterKeyFlow({ network }: { network: SodexNetwork }) {
  const { address, isConnected, connector } = useAccount();

  // We DELIBERATELY do NOT use wagmi's useWalletClient — viem's
  // signing actions enforce a chainId match between the typed-data
  // domain and the wallet's connected chain, which would force the
  // user to add SoDEX as a network in their wallet. Instead we
  // grab the raw EIP-1193 provider from the wagmi connector and
  // call `eth_signTypedData_v4` straight against it. MetaMask /
  // Rabby will sign without a chain-switch.
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);
  useEffect(() => {
    if (!connector) {
      setProvider(null);
      return;
    }
    let cancelled = false;
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

  const [accountState, setAccountState] = useState<SodexAccountState | null>(
    null,
  );
  const [remoteKeys, setRemoteKeys] = useState<SodexApiKeyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

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

  const [localKey, setLocalKey] = useState<StoredApiKey | null>(null);
  useEffect(() => {
    setLocalKey(readLocalKey(network));
  }, [network, remoteKeys]);

  const onGenerateKey = useCallback(async () => {
    if (!isConnected || !address) {
      setError("Wallet not connected — click Connect Wallet first.");
      return;
    }
    if (!accountState) {
      setError(
        "SoDEX account state not loaded yet. Hit Refresh and try again.",
      );
      return;
    }
    if (!provider) {
      setError(
        "Couldn't get a wallet provider from the connector. Try disconnecting + reconnecting your wallet.",
      );
      return;
    }
    setBusy("generate");
    setError(null);
    setActionMsg(null);
    try {
      const next = mintNewApiKey(suggestKeyName());
      await sodexAddApiKey({
        network,
        provider,
        account: address,
        accountID: accountState.aid,
        name: next.name,
        publicKey: next.address,
      });
      writeLocalKey(network, next);
      setLocalKey(next);
      setActionMsg(
        `✓ Created API key "${next.name}" — secret saved in this browser only`,
      );
      await refreshAccount();
    } catch (err) {
      setError(`Failed to add API key: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [
    isConnected,
    address,
    provider,
    accountState,
    network,
    refreshAccount,
  ]);

  const onRevokeKey = useCallback(
    async (name: string) => {
      if (!isConnected || !address || !provider || !accountState) return;
      if (
        !confirm(
          `Revoke API key "${name}"? Helix will lose the ability to trade on your account.`,
        )
      )
        return;
      setBusy(`revoke:${name}`);
      setError(null);
      setActionMsg(null);
      try {
        await sodexRevokeApiKey({
          network,
          provider,
          account: address,
          accountID: accountState.aid,
          name,
        });
        if (localKey?.name === name) clearLocalKey(network);
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
      provider,
      accountState,
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
    <>
      {/* Already-connected banner — when there's a stored API key, the
          user is already in Live mode. Show it explicitly so the page
          doesn't look like a fresh-setup form. */}
      {localKey ? (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded border border-positive/30 bg-positive/5 p-3 text-sm"
          style={{ borderColor: "rgba(52, 195, 154, 0.35)" }}
        >
          <div className="flex flex-col gap-1">
            <span
              className="font-[var(--font-jetbrains-mono)] text-[10px] uppercase text-positive"
              style={{ letterSpacing: "0.22em" }}
            >
              Live mode active
            </span>
            <span className="text-fg">
              You have a Helix-scoped SoDEX API key stored in this browser.
              Execute Live works on signal cards. Master wallet only needed
              again to rotate or revoke this key.
            </span>
            <span className="font-mono text-xs text-fg-muted">
              key: <span className="text-fg">{localKey.name || "(burner)"}</span>{" "}
              · address: <span className="text-fg">{localKey.address.slice(0, 8)}…{localKey.address.slice(-6)}</span>
            </span>
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>2. Connect your wallet</CardTitle>
          <span className="text-[11px] text-fg-dim">
            Master wallet stays cold — only signs setup actions. The
            wallet&apos;s current chain doesn&apos;t matter; SoDEX
            verifies the signature, not the network.
          </span>
        </CardHeader>
        <CardBody>
          <div className="flex items-center gap-3 flex-wrap">
            <ConnectButton
              accountStatus="address"
              chainStatus="none"
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
          </div>
        </CardBody>
      </Card>

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
              <div className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1 font-mono text-xs">
                <span className="text-fg-dim">Account ID</span>
                <span className="text-fg">{accountState.aid}</span>
                <span className="text-fg-dim">Wallet</span>
                <span className="break-all text-fg">{accountState.user}</span>
                <span className="text-fg-dim">Balances</span>
                <span className="text-fg">{balanceLine}</span>
              </div>
            ) : (
              <div className="text-sm text-fg-muted">
                Account state not loaded.
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
                No API keys registered yet — generate one to enable live
                execution.
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
                MetaMask opens once to sign addAPIKey. The new private
                key stays in your browser only.
              </span>
              <button
                onClick={onGenerateKey}
                disabled={!!busy || remoteKeys.length >= 5}
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

      <SafetyLimitsCard network={network} />

      {actionMsg ? (
        <div className="rounded border border-positive/30 bg-positive/5 px-3 py-2 text-xs text-positive">
          {actionMsg}
        </div>
      ) : null}

      {isConnected && address ? <MyTradesPanel wallet={address} /> : null}

      {isConnected && localKey ? (
        <ReadyBanner identity={localKey} network={network} />
      ) : null}
    </>
  );
}

// ─── Shared cards ───────────────────────────────────────────────────

function SafetyLimitsCard({ network }: { network: SodexNetwork }) {
  const [limits, setLimits] = useState<SafetyLimits>({
    maxPositionUsd: 10,
    maxDailyTrades: 3,
    acceptedDisclaimer: false,
  });
  useEffect(() => {
    setLimits(readSafetyLimits(network));
  }, [network]);
  const save = useCallback(
    (next: SafetyLimits) => {
      writeSafetyLimits(network, next);
      setLimits(next);
    },
    [network],
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Safety limits</CardTitle>
        <span className="text-[11px] text-fg-dim">
          Stored in this browser. Helix enforces them before signing.
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
                save({
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
                save({
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
                save({ ...limits, acceptedDisclaimer: e.target.checked })
              }
            />
            <span className="text-fg-muted">
              I understand Helix will execute trades on my SoDEX account
              and I may lose money.
            </span>
          </label>
        </div>
      </CardBody>
    </Card>
  );
}

function ReadyBanner({
  identity,
  network,
}: {
  identity: StoredApiKey;
  network: SodexNetwork;
}) {
  const limits = readSafetyLimits(network);
  if (!limits.acceptedDisclaimer) return null;
  return (
    <div className="rounded border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-accent">
      ✓ Ready to execute live on {SODEX_NETWORKS[network].label} as
      key {identity.name}. Live-execute buttons will appear on signal cards.
    </div>
  );
}

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
        <CardTitle>Your live trades</CardTitle>
        <span className="text-[11px] text-fg-dim">
          Every order this wallet has executed via Helix.
        </span>
      </CardHeader>
      <CardBody className="!p-0">
        {tradesError ? (
          <div className="p-3 text-xs text-negative">{tradesError}</div>
        ) : trades == null ? (
          <div className="p-3 text-xs text-fg-muted">Loading…</div>
        ) : trades.length === 0 ? (
          <div className="p-3 text-xs text-fg-muted">
            No live trades yet. Set limits, accept the disclaimer, then
            click <strong>▶ Execute live</strong> on any signal.
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {trades.map((t) => (
              <li
                key={t.id}
                className="grid grid-cols-[80px_120px_60px_80px_80px_100px] items-center gap-3 px-3 py-1.5 text-xs"
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
                  style={{ color: t.side === "buy" ? "#5cc97a" : "#e06c66" }}
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
