"use client";

/**
 * Connect-wallet / setup panel embedded in the /signals hero row.
 *
 * Lives in the empty whitespace right of the stat substats. The TradeMode
 * badge in the top-bar is too easy to miss, so this surfaces the
 * setup-status at the spot where users are reading their signals.
 *
 * Three states, three CTAs:
 *
 *   1. Wallet NOT connected
 *      → "Connect wallet to execute live" with a RainbowKit ConnectButton.
 *
 *   2. Wallet connected, no Helix-managed API key
 *      → "Create your Helix API key" CTA linking to /settings/connect-sodex.
 *         (Web/default SoDEX keys are ignored — see key-roles.ts.)
 *
 *   3. Wallet connected + Helix key present
 *      → "Live trading ready" confirmation strip with the short address.
 *
 * Renders nothing in /demo / public mode where live trading is suppressed.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { getAccountState } from "@/lib/sodex-onchain/client";
import { useTradeMode } from "@/lib/sodex-onchain/useTradeMode";

type Stage =
  | "loading"
  | "no-wallet"
  | "wallet-no-account"
  | "wallet-no-key"
  | "key-no-disclaimer"
  | "ready";

// NOTE: do NOT gate this panel on `isPublicMode()`. The public production
// deploy IS where users land — they need to see the "connect your wallet"
// CTA. The TradeMode badge in the topbar and the /settings/connect-sodex
// page both render on production, so this panel matches that pattern.
// (Earlier draft had a public-mode early-return that hid the panel from
// the only place users would ever see it.)

export function SignalsConnectPanel() {
  const tm = useTradeMode("mainnet");
  const { isConnected, address } = useAccount();

  // Only the PRE-KEY setup stages depend on the wagmi session. Once a
  // key exists, the stage is decided by useTradeMode — the same
  // readiness the topbar badge uses — so panel and badge never disagree.
  const [probeStage, setProbeStage] = useState<
    "loading" | "no-wallet" | "wallet-no-account" | "wallet-no-key"
  >("loading");

  useEffect(() => {
    if (tm.hasKey) return; // stage comes from tm; no account probe needed
    let cancelled = false;
    const run = async () => {
      if (!isConnected || !address) {
        if (!cancelled) setProbeStage("no-wallet");
        return;
      }
      // Wallet connected, no local key — distinguish "no SoDEX account
      // yet" (aid=0, addAPIKey would fail) from "account exists, no key".
      try {
        const state = await getAccountState("mainnet", address);
        if (cancelled) return;
        const noAccount =
          state.aid === 0 ||
          String(state.aid) === "0" ||
          state.user === "0x0000000000000000000000000000000000000000";
        setProbeStage(noAccount ? "wallet-no-account" : "wallet-no-key");
      } catch {
        if (!cancelled) setProbeStage("wallet-no-key");
      }
    };
    run();
    const t = setInterval(run, 8_000);
    window.addEventListener("storage", run);
    return () => {
      cancelled = true;
      clearInterval(t);
      window.removeEventListener("storage", run);
    };
  }, [tm.hasKey, isConnected, address]);

  const stage: Stage = tm.loading
    ? "loading"
    : tm.hasKey
      ? tm.acceptedDisclaimer
        ? "ready"
        : "key-no-disclaimer"
      : probeStage;

  const keyName = tm.keyName ?? "";
  // Pre-key stages show the connected wagmi wallet; once keyed, show the
  // key's own master/identity address (wagmi may be disconnected).
  const shortAddr = useMemo(() => {
    const a = tm.hasKey ? tm.address : address;
    if (!a) return "";
    return `${a.slice(0, 6)}…${a.slice(-4)}`;
  }, [tm.hasKey, tm.address, address]);

  if (stage === "loading") {
    // Reserve the space pre-hydration so the hero row doesn't pop in.
    return <div className="hidden md:block md:w-[360px]" aria-hidden />;
  }

  return (
    <aside
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface/40 p-4 md:w-[360px]"
      data-stage={stage}
    >
      <div className="flex items-center justify-between gap-3">
        <span
          className="text-[10px] uppercase tracking-[0.22em] text-fg-dim"
          style={{ fontFamily: "var(--font-jetbrains-mono)" }}
        >
          Live trading
        </span>
        <StageDot stage={stage} />
      </div>

      {stage === "no-wallet" && (
        <>
          <h3 className="text-sm font-medium text-fg">
            Connect a wallet to execute live
          </h3>
          <p className="text-xs leading-relaxed text-fg-muted">
            Helix never sees your private key. Connect once, sign{" "}
            <span className="font-mono text-fg">addAPIKey</span>, and trade
            from this browser. Revoke any time.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <ConnectButton
              accountStatus="address"
              chainStatus="none"
              showBalance={false}
            />
            <Link
              href="/settings/connect-sodex"
              className="text-[11px] text-fg-dim underline decoration-dotted underline-offset-4 hover:text-fg"
            >
              How it works →
            </Link>
          </div>
        </>
      )}

      {stage === "wallet-no-account" && (
        <>
          <h3 className="text-sm font-medium text-fg">
            Set up your SoDEX account first
          </h3>
          <p className="text-xs leading-relaxed text-fg-muted">
            Wallet{" "}
            <span className="font-mono text-fg">{shortAddr}</span>{" "}
            isn&apos;t registered on SoDEX yet. Bridge any token into
            SoDEX (their UI does this in one step) — that provisions
            your account. Then come back here.
          </p>
          <div className="flex flex-wrap gap-2">
            <a
              href="https://sodex.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded border border-accent/50 bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent-2 hover:bg-accent/25"
            >
              Open SoDEX ↗
            </a>
            <Link
              href="/settings/connect-sodex"
              className="inline-flex items-center text-[11px] text-fg-dim underline decoration-dotted underline-offset-4 hover:text-fg"
            >
              Full setup steps →
            </Link>
          </div>
        </>
      )}

      {stage === "wallet-no-key" && (
        <>
          <h3 className="text-sm font-medium text-fg">
            Create your Helix API key
          </h3>
          <p className="text-xs leading-relaxed text-fg-muted">
            Wallet connected as{" "}
            <span className="font-mono text-fg">{shortAddr}</span>.
            One last step: sign <span className="font-mono">addAPIKey</span>{" "}
            once to mint a trading-only key. SoDEX{" "}
            <span className="font-mono">web</span> /{" "}
            <span className="font-mono">default</span> keys don&apos;t
            count for execution.
          </p>
          <Link
            href="/settings/connect-sodex"
            className="inline-flex items-center justify-center gap-2 rounded border border-accent/50 bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent-2 transition-colors hover:border-accent/70 hover:bg-accent/25"
          >
            + Create API key →
          </Link>
        </>
      )}

      {stage === "key-no-disclaimer" && (
        <>
          <h3 className="text-sm font-medium text-fg">
            Accept the safety limits
          </h3>
          <p className="text-xs leading-relaxed text-fg-muted">
            Helix key <span className="font-mono text-fg">{keyName}</span>{" "}
            is registered. Set your per-trade max + tick the disclaimer
            to unlock the Execute Live buttons on signal cards.
          </p>
          <Link
            href="/settings/connect-sodex"
            className="inline-flex items-center justify-center gap-2 rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent-2 hover:bg-accent/20"
          >
            Set limits →
          </Link>
        </>
      )}

      {stage === "ready" && (
        <>
          <h3 className="text-sm font-medium text-fg">Live trading ready</h3>
          <p className="text-xs leading-relaxed text-fg-muted">
            ▶ Execute Live buttons are enabled on every Review/Auto card.
            Signing key:{" "}
            <span className="font-mono text-fg">{keyName}</span> ·{" "}
            wallet:{" "}
            <span className="font-mono text-fg">{shortAddr}</span>
          </p>
          <Link
            href="/settings/connect-sodex"
            className="text-[11px] text-fg-dim underline decoration-dotted underline-offset-4 hover:text-fg"
          >
            Manage keys → revoke / rotate
          </Link>
        </>
      )}
    </aside>
  );
}

function StageDot({ stage }: { stage: Stage }) {
  const color =
    stage === "ready"
      ? "#34c39a"
      : stage === "no-wallet"
        ? "#cca15a"
        : stage === "wallet-no-account"
          ? "#e2a85a" // amber — extra step required outside Helix
          : "#7a86ff"; // wallet-no-key / key-no-disclaimer — accent
  const label =
    stage === "ready"
      ? "ready"
      : stage === "no-wallet"
        ? "demo"
        : stage === "wallet-no-account"
          ? "bootstrap"
          : "setup";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: 9999,
          background: color,
        }}
      />
      <span
        className="text-[10px] uppercase tracking-[0.18em]"
        style={{ color, fontFamily: "var(--font-jetbrains-mono)" }}
      >
        {label}
      </span>
    </span>
  );
}
