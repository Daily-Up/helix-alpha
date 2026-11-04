"use client";

/**
 * CollateralCard — "Collateral backing margin": each asset posted as margin
 * (wm > 0 in the perps account) shown as balance × index price × ratio = value,
 * then free collateral and a nudge for collateral-eligible assets still sitting
 * in Spot. One of the three cards in the row under the chart + overview.
 */

import { money } from "./fmt";
import type { CollateralBreakdown } from "@/lib/portfolio/fetch";

export function CollateralCard({
  collateral,
}: {
  collateral: CollateralBreakdown | null;
}) {
  const assets = collateral?.assets ?? [];
  return (
    <div className="trade-terminal flex h-full flex-col rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-fg-dim">
          Collateral backing margin
        </span>
        <span className="font-[var(--font-jetbrains-mono)] text-[12px] tabular-nums text-fg">
          {collateral ? money(collateral.total) : "—"}
        </span>
      </div>

      {assets.length === 0 ? (
        <p className="mt-3 text-[11px] leading-relaxed text-fg-dim">
          {collateral
            ? "No assets are posted as margin. Transfer a collateral-eligible asset to Margin & Futures to start."
            : "Connect a SoDEX wallet to see your margin collateral."}
        </p>
      ) : (
        <div className="mt-2.5 flex flex-1 flex-col gap-1.5">
          {assets.slice(0, 5).map((a) => (
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
              {money(collateral?.freeCollateral)}
            </span>
          </div>
          {collateral && collateral.eligibleNotActive.length > 0 ? (
            <p className="mt-auto pt-2 text-[10px] leading-relaxed text-fg-dim">
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
      )}
    </div>
  );
}
