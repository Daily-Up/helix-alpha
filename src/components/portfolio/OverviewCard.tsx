"use client";

/**
 * OverviewCard — the right rail of the portfolio top row. A margin-usage ring
 * (green→amber→red on the terminal's thresholds), a plain-language positions
 * line, Deposit / Perps ⇄ Spot / Withdraw buttons that open SoDEX in a new tab
 * (Helix never moves funds), a colour-dotted composition (perps equity with
 * free collateral as a sub-detail, + spot holdings — the two equities summing
 * to the headline total), and a fee-tier card (tier + maker/taker + 30d volume
 * + a link to SoDEX's fee schedule).
 */

import { useEffect } from "react";
import { cn } from "@/components/ui/cn";
import { RingGauge } from "./RingGauge";
import { money, compactUsd } from "./fmt";
import type {
  EquityComposition,
  FeeRate,
  CollateralBreakdown,
} from "@/lib/portfolio/fetch";
import type { SodexPerpsAccountState } from "@/lib/sodex-onchain/types";

/** SoDEX's own pages — we link out rather than signing transfers here. */
const SODEX_WALLET = "https://sodex.com/portfolio";
const SODEX_FEES = "https://sodex.com";

export function OverviewCard({
  composition,
  account,
  feeRate,
  volume30d,
  ready,
  collateral,
  vaultEquity,
  totalUsd,
}: {
  composition: EquityComposition | null;
  account: SodexPerpsAccountState | null;
  feeRate: FeeRate | null;
  /** Combined 30d volume (perps + spot), USD. */
  volume30d: number | null;
  ready: boolean;
  /** Collateral breakdown (active-as-margin assets × ratio) + free collateral. */
  collateral: CollateralBreakdown | null;
  /** Vault (escrow) equity, counted once alongside perps + spot. */
  vaultEquity: number | null;
  /** On-exchange + vault total (excludes on-chain wallet & staked balances). */
  totalUsd: number | null;
}) {
  // Margin usage from the perps account (same derivation as AccountPanel).
  const equity = account ? Number(account.av) : null;
  const available = account ? Number(account.am) : null;
  const used =
    equity != null && available != null && Number.isFinite(equity) && Number.isFinite(available)
      ? Math.max(0, equity - available)
      : null;
  const marginRatio =
    equity != null && equity > 0 && used != null ? (used / equity) * 100 : null;
  const openCount = (account?.P ?? []).filter((p) => Number(p.sz) !== 0).length;

  // Dev guard: the two summed rows must reconcile to the headline total.
  useEffect(() => {
    if (process.env.NODE_ENV === "production" || !composition) return;
    const sum = composition.perps_equity + composition.spot_equity;
    if (Math.abs(sum - composition.total_equity) > 0.01) {
      console.warn(
        `[portfolio] Overview composition mismatch: perps_equity (${composition.perps_equity}) + ` +
          `spot_equity (${composition.spot_equity}) = ${sum}, but total_equity = ${composition.total_equity}`,
      );
    }
  }, [composition]);

  return (
    <div className="trade-terminal flex h-full flex-col gap-4 rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-fg-dim">
          Overview
        </span>
        <span className="text-[9px] uppercase tracking-wider text-fg-dim">
          SoDEX · mainnet
        </span>
      </div>

      {/* Margin-usage ring + plain-language line */}
      <div className="flex items-center gap-4">
        <RingGauge value={ready ? marginRatio : null} label="Margin used" />
        <p className="text-[13px] leading-relaxed text-fg-muted">
          {ready ? (
            <>
              You have{" "}
              <span className="font-medium text-fg">{openCount}</span> position
              {openCount === 1 ? "" : "s"} open using{" "}
              <span className="font-medium text-fg">
                {marginRatio != null ? `${marginRatio.toFixed(1)}%` : "—"}
              </span>{" "}
              of your collateral.
            </>
          ) : (
            "Connect a SoDEX wallet to see your margin usage and balances."
          )}
        </p>
      </div>

      {/* Fund actions — open SoDEX (we never move funds from Helix). */}
      <div className="grid grid-cols-3 gap-2">
        <FundButton href={SODEX_WALLET} label="Deposit" />
        <FundButton href={SODEX_WALLET} label="Perps ⇄ Spot" />
        <FundButton href={SODEX_WALLET} label="Withdraw" />
      </div>

      {/* Composition — Perps Equity + Spot Holdings (+ Vault) sum to the total;
          free collateral is a sub-detail of perps (already inside its equity). */}
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <StatRow
          dot="#0ecb81"
          label="Perps Equity"
          value={money(composition?.perps_equity)}
          hint="Perps account value, including unrealized PnL"
        />
        <SubRow
          label="Free collateral"
          value={money(composition?.free_collateral)}
          hint="Margin not currently backing a position — already counted inside Perps Equity, not added to the total"
        />
        <StatRow
          dot="#a78bfa"
          label="Spot Holdings"
          value={money(composition?.spot_equity)}
          hint="Spot balances valued at market"
        />
        {vaultEquity != null && vaultEquity > 0 ? (
          <StatRow
            dot="#e0a53f"
            label="Vault Holdings"
            value={money(vaultEquity)}
            hint="Escrow-vault fund shares, valued at NAV"
          />
        ) : null}
        {totalUsd != null ? (
          <div className="mt-1 flex items-center justify-between border-t border-line/60 pt-2 text-[12px]">
            <span className="font-medium text-fg-muted">Total</span>
            <span className="font-[var(--font-jetbrains-mono)] font-semibold tabular-nums text-fg">
              {money(totalUsd)}
            </span>
          </div>
        ) : null}
        <p className="text-[10px] leading-relaxed text-fg-dim">
          Excludes on-chain wallet &amp; staked balances (SOSO, sSOSO).
        </p>
      </div>

      {/* Collateral backing margin — active-as-margin assets × index price ×
          ratio; plus free collateral and a nudge for eligible-but-idle assets. */}
      {collateral && collateral.assets.length > 0 ? (
        <div className="flex flex-col gap-1.5 border-t border-line pt-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wider text-fg-dim">
              Collateral backing margin
            </span>
            <span className="font-[var(--font-jetbrains-mono)] text-[12px] tabular-nums text-fg">
              {money(collateral.total)}
            </span>
          </div>
          {collateral.assets.slice(0, 5).map((a) => (
            <div
              key={a.symbol}
              className="flex items-center justify-between text-[11px]"
              title={`${a.balance.toLocaleString(undefined, { maximumFractionDigits: 6 })} × ${money(a.price)} × ${(a.ratio * 100).toFixed(0)}% = ${money(a.value)}`}
            >
              <span className="text-fg-muted">
                {a.symbol}{" "}
                <span className="text-fg-dim">
                  · {(a.ratio * 100).toFixed(0)}%
                </span>
              </span>
              <span className="font-[var(--font-jetbrains-mono)] tabular-nums text-fg-muted">
                {money(a.value)}
              </span>
            </div>
          ))}
          <div className="flex items-center justify-between border-t border-line/50 pt-1.5 text-[11px]">
            <span className="text-fg-dim">Free collateral</span>
            <span className="font-[var(--font-jetbrains-mono)] tabular-nums text-fg-muted">
              {money(collateral.freeCollateral)}
            </span>
          </div>
          {collateral.eligibleNotActive.length > 0 ? (
            <p className="mt-0.5 text-[10px] leading-relaxed text-fg-dim">
              {`${collateral.eligibleNotActive
                .slice(0, 3)
                .map((e) => e.symbol)
                .join(", ")} in Spot ${
                collateral.eligibleNotActive.length === 1 ? "is" : "are"
              } eligible — transfer to Margin & Futures to use ${
                collateral.eligibleNotActive.length === 1 ? "it" : "them"
              } as collateral.`}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Fee tier card */}
      <div className="mt-auto rounded-md border border-line bg-surface-2/40 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-fg-dim">
            Fee tier
          </span>
          <a
            href={SODEX_FEES}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-[color:var(--accent-trade)] transition-opacity hover:opacity-80"
          >
            View fee tiers →
          </a>
        </div>
        <div className="mt-1.5 flex items-baseline justify-between">
          <span className="font-[var(--font-jetbrains-mono)] text-[18px] font-semibold tabular-nums text-fg">
            {feeRate ? `Tier ${feeRate.feeTier}` : "—"}
          </span>
          <span className="font-[var(--font-jetbrains-mono)] text-[11px] tabular-nums text-fg-muted">
            {feeRate
              ? `${(feeRate.makerFeeRate * 100).toFixed(3)}% / ${(feeRate.takerFeeRate * 100).toFixed(3)}%`
              : "maker / taker"}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between text-[11px]">
          <span className="text-fg-dim">30d volume</span>
          <span className="font-[var(--font-jetbrains-mono)] tabular-nums text-fg-muted">
            {volume30d != null ? compactUsd(volume30d) : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

function FundButton({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-center rounded-md border border-line bg-surface-2/60 px-2 py-2 text-center text-[11px] font-medium text-fg-muted transition-colors hover:border-line-2 hover:text-fg"
    >
      {label}
    </a>
  );
}

function StatRow({
  dot,
  label,
  value,
  hint,
}: {
  dot: string;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between text-[12px]" title={hint}>
      <span className="flex items-center gap-2 text-fg-muted">
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: dot }}
        />
        {label}
      </span>
      <span
        className={cn(
          "font-[var(--font-jetbrains-mono)] tabular-nums text-fg",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** A muted, indented sub-detail of the row above — not part of the sum. */
function SubRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div
      className="-mt-0.5 flex items-center justify-between pl-4 text-[11px]"
      title={hint}
    >
      <span className="flex items-center gap-1.5 text-fg-dim">
        <span aria-hidden className="text-fg-dim/60">
          └
        </span>
        {label}
      </span>
      <span className="font-[var(--font-jetbrains-mono)] tabular-nums text-fg-muted">
        {value}
      </span>
    </div>
  );
}
