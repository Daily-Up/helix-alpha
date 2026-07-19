"use client";

/**
 * Portfolio — the connected account's LIVE SoDEX activity, scoped per
 * account. No paper simulation: with a SoDEX identity present we show that
 * account's real mainnet orders (LiveOrdersPanel); otherwise we prompt to
 * connect. Different identity → its own orders.
 */

import Link from "next/link";
import { useTradeMode } from "@/lib/sodex-onchain/useTradeMode";
import { LiveOrdersPanel } from "@/components/sodex/LiveOrdersPanel";

export function PortfolioDashboard() {
  const tm = useTradeMode("mainnet");

  if (tm.loading) {
    return <div className="text-sm text-fg-dim">Loading…</div>;
  }
  if (!tm.hasKey) {
    return <ConnectPrompt />;
  }
  return <LiveOrdersPanel />;
}

function ConnectPrompt() {
  return (
    <div className="rounded-lg border border-line bg-surface/40 px-6 py-14 text-center">
      <div className="font-[var(--font-jetbrains-mono)] text-[10px] uppercase tracking-[0.22em] text-fg-dim">
        No account connected
      </div>
      <h2 className="mt-3 font-[var(--font-fraunces)] text-[22px] font-light text-fg">
        Connect your SoDEX wallet to view your portfolio.
      </h2>
      <p className="mx-auto mt-2.5 max-w-md text-[13px] leading-relaxed text-fg-muted">
        Authorize once on SoDEX mainnet — your live orders, from signals and
        AlphaIndex deploys, then appear here, scoped to your account. Helix
        never holds your keys.
      </p>
      <Link
        href="/settings/connect-sodex"
        className="mt-6 inline-flex items-center gap-2 rounded-[4px] border border-accent bg-accent/15 px-4 py-2 text-sm font-medium text-accent-2 transition-colors hover:bg-accent/25"
      >
        Connect SoDEX <span aria-hidden>→</span>
      </Link>
    </div>
  );
}
