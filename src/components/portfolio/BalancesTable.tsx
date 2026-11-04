"use client";

/**
 * BalancesTable — the portfolio's unified balances view, modelled on SoDEX's
 * own: one row per asset, folding its Spot / Margin & Futures / Vault holdings
 * together. A row with more than one venue expands (chevron) to the per-account
 * split. Badges mark collateral eligibility ("Multi-Asset Margin") and whether
 * an asset is currently posted as margin ("Active as margin"). Actions
 * (Transfer / Deposit / Withdraw / Subscribe / Redeem) open the matching SoDEX
 * page in a new tab — Helix never moves funds.
 *
 * On-chain wallet tokens and staked balances (SOSO, sSOSO) and the earn APY are
 * out of scope here (see docs/PORTFOLIO_PLAN.md); the total notes the exclusion.
 */

import { useMemo, useState } from "react";
import { cn } from "@/components/ui/cn";
import { AssetLogo } from "@/components/ui/AssetLogo";
import type {
  BalanceAction,
  BalanceVenue,
  UnifiedHolding,
  VenueBalance,
} from "@/lib/portfolio/fetch";
import { money } from "./fmt";

const ACTION_URL: Record<BalanceAction, string> = {
  Transfer: "https://sodex.com/portfolio",
  Deposit: "https://sodex.com/portfolio",
  Withdraw: "https://sodex.com/portfolio",
  Subscribe: "https://sodex.com/wealth",
  Redeem: "https://sodex.com/wealth",
};

// Coin | Total | USD Value | Available | Actions
const COLS =
  "minmax(190px,1.6fr) minmax(0,1.1fr) minmax(0,1fr) minmax(0,1.1fr) minmax(150px,1.1fr)";

const qty = (v: number) =>
  v === 0
    ? "0"
    : v.toLocaleString(undefined, {
        maximumFractionDigits: Math.abs(v) < 1 ? 8 : 6,
      });

export function BalancesTable({
  holdings,
  totalUsd,
  loading,
  onRefresh,
  refreshing,
}: {
  holdings: UnifiedHolding[] | null;
  totalUsd: number;
  loading: boolean;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [hideSmall, setHideSmall] = useState(true);
  const [sortDesc, setSortDesc] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const rows = useMemo(() => {
    const list = (holdings ?? []).filter(
      (h) => !hideSmall || h.usd == null || Math.abs(h.usd) >= 1,
    );
    return [...list].sort((a, b) =>
      sortDesc ? (b.usd ?? 0) - (a.usd ?? 0) : (a.usd ?? 0) - (b.usd ?? 0),
    );
  }, [holdings, hideSmall, sortDesc]);

  const smallCount = (holdings ?? []).filter(
    (h) => h.usd != null && Math.abs(h.usd) < 1,
  ).length;

  return (
    <div className="text-[12px]">
      {/* Toolbar */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-fg-dim">
          {holdings == null
            ? "—"
            : `${rows.length} asset${rows.length === 1 ? "" : "s"}`}{" "}
          · {money(totalUsd)} total
        </span>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-fg-muted">
            <input
              type="checkbox"
              checked={hideSmall}
              onChange={(e) => setHideSmall(e.target.checked)}
              className="h-3 w-3 accent-[color:var(--accent-trade)]"
            />
            Hide small balances (&lt;$1){smallCount > 0 ? ` · ${smallCount}` : ""}
          </label>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="rounded-md border border-line px-2 py-1 text-[11px] text-fg-muted transition-colors hover:border-line-2 hover:text-fg disabled:opacity-50"
            title="Refresh balances"
          >
            {refreshing ? "Refreshing…" : "↻ Refresh"}
          </button>
        </div>
      </div>

      {loading && holdings == null ? (
        <div className="px-1 py-8 text-center text-[12px] text-fg-dim">
          Loading balances…
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-[12px] text-fg-dim">
          No balances to show.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[760px]">
            {/* Header */}
            <div
              className="grid gap-2 border-b border-line px-2 py-1.5 text-[9px] uppercase tracking-wider text-fg-dim"
              style={{ gridTemplateColumns: COLS }}
            >
              <span>Coin</span>
              <span className="text-right">Total Balance</span>
              <button
                onClick={() => setSortDesc((s) => !s)}
                className="flex items-center justify-end gap-1 text-right uppercase tracking-wider transition-colors hover:text-fg-muted"
                title="Sort by USD value"
              >
                USD Value <span aria-hidden>{sortDesc ? "▼" : "▲"}</span>
              </button>
              <span className="text-right">Available</span>
              <span className="text-right">Action</span>
            </div>

            {rows.map((h) => {
              const multiVenue = h.venues.length > 1;
              const expanded = open[h.symbol] ?? false;
              return (
                <div key={h.symbol}>
                  {/* Parent / single row */}
                  <div
                    className={cn(
                      "grid items-center gap-2 px-2 py-2 font-[var(--font-jetbrains-mono)] tabular-nums transition-colors hover:bg-surface-2/40",
                      multiVenue && "cursor-pointer",
                    )}
                    style={{ gridTemplateColumns: COLS }}
                    onClick={
                      multiVenue
                        ? () =>
                            setOpen((o) => ({ ...o, [h.symbol]: !expanded }))
                        : undefined
                    }
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <button
                        aria-hidden={!multiVenue}
                        className={cn(
                          "grid h-4 w-4 shrink-0 place-items-center text-[9px] text-fg-dim transition-transform",
                          !multiVenue && "invisible",
                          expanded && "rotate-90",
                        )}
                        tabIndex={-1}
                      >
                        ▶
                      </button>
                      <AssetLogo symbol={h.logo} size={18} />
                      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="truncate font-medium text-fg">
                          {h.symbol}
                          {!multiVenue ? (
                            <span className="ml-1 font-normal text-fg-dim">
                              ({venueShort(h.venues[0].venue)})
                            </span>
                          ) : null}
                        </span>
                        <Badges holding={h} />
                      </span>
                    </span>
                    <span className="text-right text-fg">{qty(h.total)}</span>
                    <span className="text-right text-fg">
                      {h.usd != null ? money(h.usd) : "—"}
                    </span>
                    <span className="text-right text-fg-muted">
                      {qty(h.available)}
                    </span>
                    <Actions actions={h.actions} />
                  </div>

                  {/* Children (per-venue split) */}
                  {multiVenue && expanded
                    ? h.venues.map((v) => (
                        <div
                          key={`${h.symbol}-${v.venue}`}
                          className="grid items-center gap-2 border-l-2 border-line/50 bg-surface-2/20 px-2 py-1.5 font-[var(--font-jetbrains-mono)] tabular-nums"
                          style={{ gridTemplateColumns: COLS }}
                        >
                          <span className="flex min-w-0 items-center gap-2 pl-6 text-fg-muted">
                            <span className="truncate">
                              {h.symbol}{" "}
                              <span className="text-fg-dim">
                                ({venueShort(v.venue)})
                              </span>
                            </span>
                          </span>
                          <span className="text-right text-fg-muted">
                            {qty(v.total)}
                          </span>
                          <span className="text-right text-fg-muted">
                            {v.usd != null ? money(v.usd) : "—"}
                          </span>
                          <span className="text-right text-fg-dim">
                            {qty(v.available)}
                          </span>
                          <Actions actions={h.actions} muted />
                        </div>
                      ))
                    : null}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-fg-dim">
        Excludes on-chain wallet &amp; staked balances (SOSO, sSOSO) — those are
        held outside SoDEX&apos;s spot/perps/vault accounts. Prices are SoDEX
        index marks; collateral ratios from the live margin config.
      </p>
    </div>
  );
}

function Badges({ holding }: { holding: UnifiedHolding }) {
  const pct =
    holding.marginRatio != null
      ? `${(holding.marginRatio * 100).toFixed(0)}%`
      : null;
  // Consistent with the collateral-backing list: an asset with wm > 0 in perps
  // (activeAsMargin) reads green "Active as margin"; a collateral-eligible asset
  // still sitting in Spot reads blue "Multi-Asset Margin" with a transfer nudge.
  if (holding.activeAsMargin) {
    return (
      <span
        className="rounded bg-positive/12 px-1.5 py-px text-[9px] font-medium text-positive"
        title="Currently backing your margin (posted in the perps account)"
      >
        ✓ Active as margin{pct ? ` · ${pct}` : ""}
      </span>
    );
  }
  if (holding.multiAssetMargin) {
    return (
      <span
        className="rounded bg-[color:var(--accent-trade)]/12 px-1.5 py-px text-[9px] font-medium text-[color:var(--accent-trade)]"
        title="Eligible as margin collateral — transfer to Margin & Futures to use it"
      >
        Multi-Asset Margin{pct ? ` · ${pct}` : ""}
      </span>
    );
  }
  return null;
}

function Actions({
  actions,
  muted,
}: {
  actions: BalanceAction[];
  muted?: boolean;
}) {
  return (
    <span
      className="flex items-center justify-end gap-2.5 text-[11px]"
      onClick={(e) => e.stopPropagation()}
    >
      {actions.map((a) => (
        <a
          key={a}
          href={ACTION_URL[a]}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "transition-colors hover:text-[color:var(--accent-trade)]",
            muted ? "text-fg-dim" : "text-fg-muted",
          )}
        >
          {a}
        </a>
      ))}
    </span>
  );
}

function venueShort(v: BalanceVenue): string {
  return v === "Margin & Futures" ? "Margin & Futures" : v;
}

// Re-exported for parents that want the row type.
export type { VenueBalance };
