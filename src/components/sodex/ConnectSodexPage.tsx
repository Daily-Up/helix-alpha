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
import { Addr } from "@/components/ui/Addr";
import { Timestamp } from "@/components/ui/Timestamp";
import { DataTable } from "@/components/ui/DataTable";
import { fmtSodexSymbol } from "@/lib/format";
import {
  SODEX_NETWORKS,
  type SodexNetwork,
} from "@/lib/sodex-onchain/chains";
import {
  addApiKey as sodexAddApiKey,
  getAccountState,
  getPerpsAccountState,
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
  SodexPerpsAccountState,
} from "@/lib/sodex-onchain/types";
import {
  isHelixManagedKey,
  systemKeys as filterSystemKeys,
  userManagedKeys,
} from "@/lib/sodex-onchain/key-roles";
import { SodexBalancesTable } from "./SodexBalancesTable";

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
  // Perps account state is fetched in parallel with spot. A wallet
  // that only ever traded spot will get a zero-state envelope (aid=0,
  // empty balances) — we surface "no perps account" in the UI rather
  // than treating it as an error.
  const [perpsState, setPerpsState] = useState<SodexPerpsAccountState | null>(
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
      setPerpsState(null);
      setRemoteKeys([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Fetch all three in parallel — independent, ~50ms each on
      // mainnet-gw. Failures on perps fall through silently so a
      // perps outage doesn't block the spot setup flow.
      const [spotRes, perpsRes, keysRes] = await Promise.allSettled([
        getAccountState(network, address),
        getPerpsAccountState(network, address),
        listApiKeys(network, address),
      ]);
      if (spotRes.status === "fulfilled") setAccountState(spotRes.value);
      if (perpsRes.status === "fulfilled") setPerpsState(perpsRes.value);
      else setPerpsState(null);
      if (keysRes.status === "fulfilled") setRemoteKeys(keysRes.value);
      if (spotRes.status === "rejected") {
        setError((spotRes.reason as Error).message);
      }
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

  // True when the connected wallet has no SoDEX account yet (aid=0 +
  // zero user address). SoDEX returns a default empty state for
  // unknown wallets — the addAPIKey call would fail at the gateway
  // with "accountID is required" because aid=0 isn't a real account.
  // The user has to bootstrap an account on sodex.com (a deposit
  // auto-creates one) before Helix can register a trading key.
  const isUnregistered = !!(
    accountState &&
    (accountState.aid === 0 ||
      String(accountState.aid) === "0" ||
      accountState.user === "0x0000000000000000000000000000000000000000")
  );

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
    if (isUnregistered) {
      setError(
        "This wallet has no SoDEX account yet. Open sodex.com → connect the same wallet → deposit any amount (auto-creates your account) → come back here and refresh.",
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
      // Remember the master wallet that signed addAPIKey. ExecuteLive
      // needs this to look up the SoDEX account (`aid`) at trade time
      // — the API key's own address has no account and would return
      // aid=0, which causes "AccountID failed on the required tag" at
      // the order endpoint.
      next.masterAddress = address;
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

  // Balance display now lives inside `SodexBalancesTable`, which
  // renders a SoDEX-style table grouped by coin with spot + futures
  // sub-rows and live USD valuation for the priced coins.

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
              · address: <Addr value={localKey.address} tail={6} />
            </span>
          </div>
        </div>
      ) : null}

      {/* Wallet card is a required SETUP step when there's no key yet,
          but only an OPTIONAL "manage keys" affordance once you're live
          — so it doesn't read as a step you skipped. */}
      <Card>
        <CardHeader>
          <CardTitle>
            {localKey ? "Manage keys (optional)" : "Connect your wallet"}
          </CardTitle>
          <span className="text-[11px] text-fg-dim">
            {localKey
              ? "You're already live. Reconnect your master wallet only to rotate or revoke your key — it isn't needed to trade."
              : "Your master wallet stays cold — it only signs the one-time setup. The wallet's current chain doesn't matter; SoDEX verifies the signature, not the network."}
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
                connected as <Addr value={address} />
              </span>
            ) : localKey ? (
              <span className="text-xs text-fg-dim">
                Not needed unless rotating or revoking.
              </span>
            ) : null}
          </div>
        </CardBody>
      </Card>

      {isConnected ? (
        <Card>
          <CardHeader>
            <CardTitle>Your SoDEX account</CardTitle>
            <span className="text-[11px] text-fg-dim">
              live data from {SODEX_NETWORKS[network].label}
            </span>
          </CardHeader>
          <CardBody>
            {loading ? (
              <div className="text-sm text-fg-muted">Loading…</div>
            ) : accountState ? (
              <div className="flex flex-col gap-4">
                {/* Identity strip — Account IDs + wallet — sits above
                    the balance table so users can verify they're
                    looking at the right SoDEX account before reading
                    numbers off the table. */}
                <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 font-mono text-xs">
                  <span className="text-fg-dim">Spot Account ID</span>
                  <span className="text-fg">{accountState.aid}</span>
                  <span className="text-fg-dim">Perps Account ID</span>
                  <span className="text-fg">{perpsState?.aid ?? 0}</span>
                  <span className="text-fg-dim">Wallet</span>
                  <Addr value={accountState.user} />
                </div>

                <SodexBalancesTable
                  network={network}
                  spotState={accountState}
                  perpsState={perpsState}
                />

                {perpsState && perpsState.aid === 0 ? (
                  <p className="text-[11px] text-fg-dim">
                    No perps account on this wallet — you can still trade
                    spot. Open a perps account on{" "}
                    <a
                      href="https://sodex.com/trade"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline decoration-dotted underline-offset-4 hover:text-fg"
                    >
                      sodex.com/trade
                    </a>{" "}
                    by depositing into the perps gateway.
                  </p>
                ) : null}
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

      {/* Unregistered → bootstrap flow. SoDEX returns aid=0 for any
          wallet that never deposited, so `addAPIKey` would fail with
          "accountID is required". Direct the user to sodex.com to
          create the account via a deposit; come back, refresh, and
          the regular Generate flow takes over. */}
      {isConnected && accountState && isUnregistered ? (
        <Card>
          <CardHeader>
            <CardTitle>Create your SoDEX account first</CardTitle>
            <span className="text-[11px] text-fg-dim">
              one-time bootstrap — Helix can&apos;t register a key until
              SoDEX recognises your wallet
            </span>
          </CardHeader>
          <CardBody>
            <div className="flex flex-col gap-3">
              <p className="text-sm text-fg">
                Wallet <Addr value={address} /> isn&apos;t registered on{" "}
                {SODEX_NETWORKS[network].label} yet (account ID is{" "}
                <span className="font-mono">0</span>). That&apos;s why
                you saw{" "}
                <span className="font-mono text-fg-muted">
                  &quot;accountID is required&quot;
                </span>{" "}
                when generating an API key.
              </p>

              <ol className="ml-5 list-decimal space-y-1.5 text-xs text-fg-muted">
                <li>
                  Open{" "}
                  <a
                    href="https://sodex.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent-2 underline decoration-dotted underline-offset-4 hover:text-accent"
                  >
                    sodex.com
                  </a>
                  {" "}and connect the same wallet.
                </li>
                <li>
                  Deposit any token via the SoDEX UI (their bridge from
                  Base / Ethereum / etc). SoDEX provisions your account
                  on the first deposit.
                </li>
                <li>
                  Come back here and hit{" "}
                  <strong className="text-fg">Refresh</strong>. Your
                  Account ID should change from{" "}
                  <span className="font-mono">0</span> to a real number
                  — at that point Helix can register a trading key with
                  one MetaMask click.
                </li>
              </ol>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <a
                  href="https://sodex.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded border border-accent/50 bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent-2 transition-colors hover:border-accent/70 hover:bg-accent/25"
                >
                  Open SoDEX ↗
                </a>
                <button
                  onClick={refreshAccount}
                  disabled={loading}
                  className="rounded border border-line bg-surface px-3 py-1.5 text-xs text-fg-muted hover:border-line-2 hover:text-fg"
                >
                  {loading ? "Refreshing…" : "↻ Refresh account state"}
                </button>
                <span className="text-[11px] text-fg-dim">
                  No deposit-bridge UI in Helix yet — keeps signing
                  surface minimal.
                </span>
              </div>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {isConnected && accountState && !isUnregistered ? (
        <Card>
          <CardHeader>
            <CardTitle>Helix API keys</CardTitle>
            <span className="text-[11px] text-fg-dim">
              SoDEX allows up to 5 keys per account
            </span>
          </CardHeader>
          <CardBody className="!p-0">
            {(() => {
              // Split keys: anything Helix-managed or third-party gets
              // shown to the user; SoDEX system keys (`default`,
              // `web`) are hidden from the main list and surfaced as
              // a small note so users still understand the 5-cap.
              const userKeys = userManagedKeys(remoteKeys);
              const sysKeys = filterSystemKeys(remoteKeys);
              const hasHelixUsable = userKeys.some((k) =>
                isHelixManagedKey(k.name),
              );

              return (
                <>
                  {userKeys.length === 0 ? (
                    <div className="flex flex-col gap-2 p-4 text-sm">
                      <span className="text-fg">
                        No Helix API key on this account yet.
                      </span>
                      <span className="text-fg-muted text-xs">
                        Click <strong>+ Generate new key</strong> below.
                        Your master wallet signs once; the new key&apos;s
                        secret lives only in this browser. Required to
                        enable the <strong>▶ Execute live</strong>
                        {" "}button on signal cards.
                      </span>
                    </div>
                  ) : (
                    <ul className="divide-y divide-line">
                      {userKeys.map((k) => {
                        const isLocal = localKey?.name === k.name;
                        const isHelix = isHelixManagedKey(k.name);
                        return (
                          <li
                            key={k.name}
                            className="grid grid-cols-[1fr_120px_120px] items-center gap-3 px-4 py-2 text-xs"
                          >
                            <div className="flex flex-col">
                              <span className="font-mono font-medium text-fg">
                                {k.name}
                              </span>
                              <Addr
                                value={k.publicKey}
                                tail={6}
                                className="text-[10px] text-fg-dim"
                              />
                            </div>
                            <div className="flex flex-col items-start gap-0.5">
                              {isHelix ? (
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
                              <button
                                onClick={() => onRevokeKey(k.name)}
                                disabled={!!busy}
                                className="rounded border border-line px-2 py-0.5 text-[10px] text-fg-muted hover:border-negative/40 hover:text-negative"
                              >
                                {busy === `revoke:${k.name}`
                                  ? "Revoking…"
                                  : "Revoke"}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {sysKeys.length > 0 ? (
                    <div className="border-t border-line bg-surface-2 px-4 py-2 text-[10px] text-fg-dim">
                      SoDEX system keys (hidden from list, ignored for
                      Helix execution):{" "}
                      <span className="font-mono">
                        {sysKeys.map((k) => k.name).join(", ")}
                      </span>
                      . They count toward SoDEX&apos;s 5-key cap but
                      cannot be used to sign Helix trades.
                    </div>
                  ) : null}

                  <div className="flex items-center justify-between gap-3 border-t border-line p-3">
                    <span className="text-[11px] text-fg-dim">
                      {hasHelixUsable
                        ? "Rotate the existing key, or add a second one."
                        : "MetaMask opens once to sign addAPIKey. The new private key stays in your browser only."}
                    </span>
                    <button
                      onClick={onGenerateKey}
                      disabled={!!busy || remoteKeys.length >= 5}
                      className={cn(
                        "rounded border px-3 py-1.5 text-xs font-medium transition-colors",
                        busy === "generate"
                          ? "cursor-wait border-line bg-surface-2 text-fg-dim"
                          : hasHelixUsable
                            ? "border-line bg-surface text-fg-muted hover:border-accent/40 hover:text-accent-2"
                            : "border-accent/50 bg-accent/20 text-accent-2 hover:bg-accent/30",
                      )}
                    >
                      {busy === "generate"
                        ? "Generating…"
                        : hasHelixUsable
                          ? "+ Generate new key"
                          : "+ Create your first Helix API key"}
                    </button>
                  </div>
                </>
              );
            })()}
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
    maxPositionUsd: 11,
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
            <span className="text-fg-dim">Live order size (USD)</span>
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
            <span className="text-[10px] text-fg-dim">
              Each Execute-live order uses this amount (min ~$10 on SoDEX).
            </span>
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
          <DataTable<ExecutedTradeView>
            columns={[
              {
                key: "status",
                header: "Status",
                role: "identifier",
                render: (t) => (
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
                ),
              },
              {
                key: "symbol",
                header: "Market",
                role: "identifier",
                render: (t) => fmtSodexSymbol(t.symbol),
              },
              {
                key: "side",
                header: "Side",
                role: "identifier",
                render: (t) => (
                  <span
                    className="font-mono"
                    style={{
                      color: t.side === "buy" ? "#5cc97a" : "#e06c66",
                    }}
                  >
                    {t.side.toUpperCase()}
                  </span>
                ),
              },
              {
                key: "size",
                header: "Size",
                role: "context",
                num: (t) => t.size_usd,
                unit: "$",
                dp: 0,
              },
              {
                key: "network",
                header: "Net",
                role: "context",
                render: (t) => t.network,
              },
              {
                key: "filled_at",
                header: "Filled",
                role: "context",
                render: (t) => <Timestamp ms={t.filled_at} mode="absolute" />,
              },
            ]}
            rows={trades}
            getKey={(t) => t.id}
            minWidth={520}
          />
        )}
      </CardBody>
    </Card>
  );
}
