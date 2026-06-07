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
import {
  readLocalKey,
  readSafetyLimits,
} from "@/lib/sodex-onchain/local-keys";
import { isPublicMode } from "@/lib/public-mode";

type Stage =
  | "loading"
  | "no-wallet"
  | "wallet-no-key"
  | "key-no-disclaimer"
  | "ready";

export function SignalsConnectPanel() {
  // Hide the panel entirely on the public demo deploy — live execution
  // isn't reachable there anyway.
  if (isPublicMode()) return null;

  const { isConnected, address } = useAccount();

  const [stage, setStage] = useState<Stage>("loading");
  const [keyName, setKeyName] = useState<string>("");

  // Re-check localStorage every 5s + on storage events so that finishing
  // the connect-sodex flow in another tab updates this panel without
  // requiring a refresh.
  useEffect(() => {
    const refresh = () => {
      const localKey = readLocalKey("mainnet");
      const limits = readSafetyLimits("mainnet");
      if (!isConnected) {
        setStage("no-wallet");
        return;
      }
      if (!localKey) {
        setStage("wallet-no-key");
        return;
      }
      setKeyName(localKey.name || "(burner)");
      setStage(limits.acceptedDisclaimer ? "ready" : "key-no-disclaimer");
    };
    refresh();
    const t = setInterval(refresh, 5_000);
    window.addEventListener("storage", refresh);
    return () => {
      clearInterval(t);
      window.removeEventListener("storage", refresh);
    };
  }, [isConnected]);

  const shortAddr = useMemo(() => {
    if (!address) return "";
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
  }, [address]);

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
        : "#7a86ff"; // wallet-no-key / key-no-disclaimer — accent
  const label =
    stage === "ready"
      ? "ready"
      : stage === "no-wallet"
        ? "demo"
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
