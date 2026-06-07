"use client";

/**
 * SoDEX-style balances table.
 *
 * Mirrors the layout sodex.com/wallet shows under their "Coin" tab:
 *
 *   Coin                Total Balance       USD Value     Available    Action
 *   USDC                289.821858 USDC     $289.82       289.821858   Transfer Deposit Withdraw
 *     USDC (Spot)       4.656045 USDC       $4.65         4.656045     Transfer Deposit Withdraw
 *     USDC (Futures)    284.165813 USDC     $284.16       284.165813   Transfer Deposit Withdraw
 *   ETH (Spot)          0.006695 ETH        $10.82        0.006695     Transfer Deposit Withdraw
 *
 * Source data is whatever `getAccountState` (spot) and
 * `getPerpsAccountState` (perps) return — we don't read anything
 * extra. EVM-funding rows are skipped because the spot/perps gateway
 * doesn't expose them; sodex.com fetches them from a different
 * /accounts/{address}/funding endpoint that isn't documented in the
 * trading-api spec we use. The "Stake to Earn" / Unstake action is
 * also out of scope for the trading flow.
 *
 * Action buttons link to sodex.com/wallet — we don't sign transfers
 * or withdrawals from this codebase. The buttons are there so the
 * page feels like SoDEX's, not so it actually does the action.
 */

import { useEffect, useMemo, useState } from "react";
import {
  type SodexAccountState,
  type SodexPerpsAccountState,
} from "@/lib/sodex-onchain/types";
import { getLivePrice } from "@/lib/sodex-onchain/client";
import { type SodexNetwork } from "@/lib/sodex-onchain/chains";
import { fmtSodexCoin as displayCoin } from "@/lib/format";

interface BalanceRow {
  coin: string;
  /** "spot" | "futures" — used as the "(X)" suffix on the row label. */
  venue: "spot" | "futures";
  /** Decimal-string of total balance. */
  total: string;
  /** Decimal-string of available (total - locked) balance. */
  available: string;
}

interface CoinGroup {
  coin: string;
  totalBalance: number;
  totalAvailable: number;
  totalUsd: number | null;
  rows: BalanceRow[];
  usdPrice: number | null;
}

interface Props {
  network: SodexNetwork;
  spotState: SodexAccountState | null;
  perpsState: SodexPerpsAccountState | null;
}

function num(s: string | undefined | null): number {
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** Stables we treat as $1 without bothering the ticker endpoint. */
const ONE_USD_COINS = new Set(["vUSDC", "USDC", "vUSDT", "USDT"]);

/** Coins we know we can price via a `<coin>_vUSDC` pair on /markets/tickers. */
const TICKER_PAIR_FOR_COIN: Record<string, string> = {
  vETH: "vETH_vUSDC",
  vBTC: "vBTC_vUSDC",
  vSOL: "vSOL_vUSDC",
  vBNB: "vBNB_vUSDC",
  vHYPE: "vHYPE_vUSDC",
};

export function SodexBalancesTable({ network, spotState, perpsState }: Props) {
  const rows = useMemo<BalanceRow[]>(() => {
    const out: BalanceRow[] = [];
    for (const b of spotState?.B ?? []) {
      const total = num(b.t);
      const locked = num(b.l);
      out.push({
        coin: b.a,
        venue: "spot",
        total: b.t,
        available: (total - locked).toFixed(6),
      });
    }
    for (const b of perpsState?.B ?? []) {
      const total = num(b.t);
      const locked = num(b.l);
      out.push({
        coin: b.a,
        venue: "futures",
        total: b.t,
        available: (total - locked).toFixed(6),
      });
    }
    return out;
  }, [spotState, perpsState]);

  // Group by coin so USDC spot + futures fold into one parent line
  // with two sub-rows, matching SoDEX's wallet UI.
  const groups = useMemo<CoinGroup[]>(() => {
    const byCoin = new Map<string, CoinGroup>();
    for (const r of rows) {
      const g = byCoin.get(r.coin) ?? {
        coin: r.coin,
        totalBalance: 0,
        totalAvailable: 0,
        totalUsd: null,
        rows: [],
        usdPrice: null,
      };
      g.rows.push(r);
      g.totalBalance += num(r.total);
      g.totalAvailable += num(r.available);
      byCoin.set(r.coin, g);
    }
    // Stable sort: USDC first, then by total descending so the heaviest
    // bag tops the table.
    return [...byCoin.values()].sort((a, b) => {
      const aStable = ONE_USD_COINS.has(a.coin) ? 0 : 1;
      const bStable = ONE_USD_COINS.has(b.coin) ? 0 : 1;
      if (aStable !== bStable) return aStable - bStable;
      return b.totalBalance - a.totalBalance;
    });
  }, [rows]);

  // Resolve USD prices for the coins in the table. Stables → 1. Others
  // → live ticker. Done once when groups change.
  const [pricedGroups, setPricedGroups] = useState<CoinGroup[]>(groups);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const enriched: CoinGroup[] = [];
      for (const g of groups) {
        let price: number | null = null;
        if (ONE_USD_COINS.has(g.coin)) {
          price = 1;
        } else {
          const pair = TICKER_PAIR_FOR_COIN[g.coin];
          if (pair) {
            try {
              const p = await getLivePrice(network, pair, "sell");
              if (p && p > 0) price = p;
            } catch {
              /* keep null */
            }
          }
        }
        enriched.push({
          ...g,
          usdPrice: price,
          totalUsd: price != null ? price * g.totalBalance : null,
        });
      }
      if (!cancelled) setPricedGroups(enriched);
    })();
    return () => {
      cancelled = true;
    };
  }, [groups, network]);

  if (groups.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No SoDEX balances. Deposit any token via{" "}
        <a
          href="https://sodex.com/wallet"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-2 underline decoration-dotted underline-offset-4"
        >
          sodex.com/wallet
        </a>{" "}
        to fund your account.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="text-left text-fg-dim">
            <Th>Coin</Th>
            <Th className="text-right">Total Balance</Th>
            <Th className="text-right">USD Value</Th>
            <Th className="text-right">Available Balance</Th>
            <Th className="text-right">Action</Th>
          </tr>
        </thead>
        <tbody>
          {pricedGroups.map((g) => {
            // If there's only ONE venue for this coin, render it as a
            // single labelled row (e.g. "ETH (Spot)"). If TWO+ venues,
            // render a parent total row followed by indented sub-rows.
            const single = g.rows.length === 1;
            if (single) {
              const r = g.rows[0];
              return (
                <Row
                  key={`${g.coin}-${r.venue}`}
                  label={`${displayCoin(g.coin)} (${venueLabel(r.venue)})`}
                  total={`${r.total} ${displayCoin(g.coin)}`}
                  usd={g.usdPrice != null ? num(r.total) * g.usdPrice : null}
                  available={r.available}
                />
              );
            }
            return (
              <>
                <Row
                  key={g.coin}
                  label={displayCoin(g.coin)}
                  total={`${g.totalBalance.toFixed(6)} ${displayCoin(g.coin)}`}
                  usd={g.totalUsd}
                  available={g.totalAvailable.toFixed(6)}
                  isParent
                />
                {g.rows.map((r) => (
                  <Row
                    key={`${g.coin}-${r.venue}`}
                    label={`${displayCoin(g.coin)} (${venueLabel(r.venue)})`}
                    total={`${r.total} ${displayCoin(g.coin)}`}
                    usd={g.usdPrice != null ? num(r.total) * g.usdPrice : null}
                    available={r.available}
                    isChild
                  />
                ))}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function venueLabel(v: "spot" | "futures"): string {
  return v === "spot" ? "Spot" : "Futures";
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`border-b border-line py-2 pr-3 font-normal uppercase tracking-[0.15em] ${className ?? ""}`}
      style={{
        fontSize: 10,
        fontFamily: "var(--font-jetbrains-mono)",
        letterSpacing: "0.18em",
      }}
    >
      {children}
    </th>
  );
}

function Row({
  label,
  total,
  usd,
  available,
  isParent,
  isChild,
}: {
  label: string;
  total: string;
  usd: number | null;
  available: string;
  isParent?: boolean;
  isChild?: boolean;
}) {
  return (
    <tr className="border-b border-line/70 align-middle">
      <td
        className={`py-2 pr-3 ${isParent ? "font-medium text-fg" : "text-fg"}`}
        style={{ paddingLeft: isChild ? 22 : 0 }}
      >
        {label}
      </td>
      <td className="py-2 pr-3 text-right font-mono text-fg">{total}</td>
      <td className="py-2 pr-3 text-right font-mono text-fg">
        {usd != null ? `$${usd.toFixed(2)}` : "—"}
      </td>
      <td className="py-2 pr-3 text-right font-mono text-fg">{available}</td>
      <td className="py-2 text-right">
        <ActionLinks />
      </td>
    </tr>
  );
}

function ActionLinks() {
  return (
    <span className="inline-flex gap-3 text-[11px]">
      <a
        href="https://sodex.com/wallet"
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent-2 hover:text-accent"
      >
        Transfer
      </a>
      <a
        href="https://sodex.com/wallet"
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent-2 hover:text-accent"
      >
        Deposit
      </a>
      <a
        href="https://sodex.com/wallet"
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent-2 hover:text-accent"
      >
        Withdraw
      </a>
    </span>
  );
}
