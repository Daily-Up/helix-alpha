"use client";

/**
 * PortfolioDashboard — the connected account's live SoDEX portfolio, modelled
 * on SoDEX's own portfolio page and built from the trade terminal's design
 * system. Top row: equity curve (left) + Overview card (right). Below:
 * Spot / Perpetuals tabs. Bottom: a muted "Traded via Helix" strip.
 *
 * All data is read-only SoDEX REST + our equity snapshots — no signing here.
 */

import { useCallback, useEffect, useState } from "react";
import { useTradeMode } from "@/lib/sodex-onchain/useTradeMode";
import { useSodexAuth } from "@/components/sodex/auth/SodexAuthProvider";
import { getPerpsAccountState } from "@/lib/sodex-onchain/client";
import type { SodexPerpsAccountState } from "@/lib/sodex-onchain/types";
import type { SymbolMeta } from "@/lib/sodex-onchain/useSodexTradeActions";
import {
  fetchFeeRate,
  fetchTradeStats,
  fetchPortfolioBalances,
  type EquityComposition,
  type FeeRate,
  type TradeStats,
  type PortfolioBalances,
} from "@/lib/portfolio/fetch";
import { EquityChart } from "./EquityChart";
import { OverviewCard } from "./OverviewCard";
import { CollateralCard } from "./CollateralCard";
import { FeeTierCard } from "./FeeTierCard";
import { PortfolioActivity } from "./PortfolioActivity";
import { HelixStrip } from "./HelixStrip";

export function PortfolioDashboard({
  symbolMeta = {},
}: {
  /** Per-symbol metadata for the Perps tab (same source as /trade). */
  symbolMeta?: Record<string, SymbolMeta>;
}) {
  const tm = useTradeMode("mainnet");
  const address = tm.address;

  const [account, setAccount] = useState<SodexPerpsAccountState | null>(null);
  const [composition, setComposition] = useState<EquityComposition | null>(null);
  const [feeRate, setFeeRate] = useState<FeeRate | null>(null);
  const [tradeStats, setTradeStats] = useState<TradeStats | null>(null);
  const [balances, setBalances] = useState<PortfolioBalances | null>(null);
  const [balancesRefreshing, setBalancesRefreshing] = useState(false);

  // Live perps account state — margin ring + (later) the Perps tab. Read-only.
  const refreshAccount = useCallback(async () => {
    if (!tm.ready || !address) {
      setAccount(null);
      return;
    }
    try {
      setAccount(await getPerpsAccountState("mainnet", address));
    } catch {
      /* keep last good */
    }
  }, [tm.ready, address]);
  useEffect(() => {
    refreshAccount();
    const t = setInterval(refreshAccount, 5000);
    return () => clearInterval(t);
  }, [refreshAccount]);

  // Record an equity snapshot on visit (throttled server-side to 15 min) and
  // read back the live composition it computes. Refreshed on a slow cadence.
  const refreshComposition = useCallback(async () => {
    if (!tm.ready || !address) {
      setComposition(null);
      return;
    }
    try {
      const r = await fetch("/api/portfolio/equity-snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const j = await r.json();
      if (j.ok) setComposition(j.computed as EquityComposition);
    } catch {
      /* keep last good */
    }
  }, [tm.ready, address]);
  useEffect(() => {
    refreshComposition();
    const t = setInterval(refreshComposition, 60_000);
    return () => clearInterval(t);
  }, [refreshComposition]);

  // Unified balances (Spot + Margin & Futures + Vault) + collateral breakdown.
  // One sweep of the public gateway + wealth endpoints; refreshed on a slow
  // cadence and on the Balances tab's manual refresh.
  const refreshBalances = useCallback(async () => {
    if (!tm.ready || !address) {
      setBalances(null);
      return;
    }
    setBalancesRefreshing(true);
    try {
      setBalances(await fetchPortfolioBalances(address));
    } catch {
      /* keep last good */
    } finally {
      setBalancesRefreshing(false);
    }
  }, [tm.ready, address]);
  useEffect(() => {
    refreshBalances();
    const t = setInterval(refreshBalances, 30_000);
    return () => clearInterval(t);
  }, [refreshBalances]);

  // Fee tier + trade-derived stats (30d volume, Helix strip). One sweep on
  // connect; these move slowly, so they aren't polled.
  useEffect(() => {
    if (!tm.ready || !address) {
      setFeeRate(null);
      setTradeStats(null);
      return;
    }
    let cancelled = false;
    fetchFeeRate(address, "perp")
      .then((f) => !cancelled && setFeeRate(f))
      .catch(() => {});
    fetchTradeStats(address)
      .then((s) => !cancelled && setTradeStats(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tm.ready, address]);

  if (tm.loading) {
    return (
      <div className="trade-terminal">
        <div className="rounded-lg border border-line bg-surface px-6 py-14 text-center text-[13px] text-fg-dim">
          Loading your portfolio…
        </div>
      </div>
    );
  }
  if (!tm.hasKey) {
    return <ConnectPrompt />;
  }

  return (
    <div className="trade-terminal flex flex-col gap-4">
      {/* Top row: equity curve (≈70%, fixed height) + Overview (≈30%). */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="h-[350px]">
          <EquityChart
            address={address}
            liveTotals={
              balances
                ? {
                    perps: balances.perpsEquity,
                    spot: balances.spotEquity,
                    total: balances.totalUsd,
                  }
                : null
            }
          />
        </div>
        <OverviewCard
          composition={composition}
          account={account}
          ready={tm.ready}
          vaultEquity={balances?.vaultEquity ?? null}
          totalUsd={balances?.totalUsd ?? null}
        />
      </div>

      {/* Collateral · Fee tier · Traded via Helix — equal-height cards, three
          across at 1920, two at 1440, one on mobile. */}
      <div className="grid grid-cols-1 items-stretch gap-4 sm:grid-cols-2 2xl:grid-cols-3">
        <CollateralCard collateral={balances?.collateral ?? null} />
        <FeeTierCard
          feeRate={feeRate}
          volume30d={tradeStats?.volume30d.total ?? null}
        />
        <HelixStrip helix={tradeStats?.helix ?? null} />
      </div>

      {/* Unified balances + trading activity (Balances · Positions · Open
          Orders · Trade/Funding/Order/Position History · Deposits). */}
      <PortfolioActivity
        tm={tm}
        account={account}
        refreshAccount={refreshAccount}
        symbolMeta={symbolMeta}
        holdings={balances?.holdings ?? null}
        totalUsd={balances?.totalUsd ?? 0}
        balancesLoading={balances == null}
        onRefreshBalances={refreshBalances}
        balancesRefreshing={balancesRefreshing}
      />
    </div>
  );
}

function ConnectPrompt() {
  const auth = useSodexAuth();
  return (
    <div className="trade-terminal">
      <div className="rounded-lg border border-line bg-surface px-6 py-14 text-center">
        <div className="font-[var(--font-jetbrains-mono)] text-[10px] uppercase tracking-[0.22em] text-fg-dim">
          No account connected
        </div>
        <h2 className="mt-3 text-[22px] font-light text-fg">
          Connect your SoDEX wallet to view your portfolio.
        </h2>
        <p className="mx-auto mt-2.5 max-w-md text-[13px] leading-relaxed text-fg-muted">
          Authorize once on SoDEX mainnet — your equity curve, balances,
          positions and Helix-routed activity then appear here, scoped to your
          account. Helix never holds your keys.
        </p>
        <button
          onClick={() => auth.openSetup()}
          className="mt-6 inline-flex items-center gap-2 rounded-md border border-[color:var(--accent-trade)]/50 bg-[color:var(--accent-trade)]/15 px-4 py-2 text-sm font-medium text-[color:var(--accent-trade)] transition-colors hover:bg-[color:var(--accent-trade)]/25"
        >
          {auth.step === "wallet" ? "Connect" : "Finish setup"} <span aria-hidden>→</span>
        </button>
      </div>
    </div>
  );
}
