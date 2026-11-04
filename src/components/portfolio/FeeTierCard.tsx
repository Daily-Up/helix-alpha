"use client";

/**
 * FeeTierCard — SoDEX fee tier (tier number + maker/taker) and 30d volume, with
 * a link out to SoDEX's fee schedule. One of the three cards in the row under
 * the chart + overview.
 */

import { compactUsd } from "./fmt";
import type { FeeRate } from "@/lib/portfolio/fetch";

const SODEX_FEES = "https://sodex.com";

export function FeeTierCard({
  feeRate,
  volume30d,
}: {
  feeRate: FeeRate | null;
  /** Combined 30d volume (perps + spot), USD. */
  volume30d: number | null;
}) {
  return (
    <div className="trade-terminal flex h-full flex-col rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-fg-dim">
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
      <div className="mt-2 flex items-baseline justify-between">
        <span className="font-[var(--font-jetbrains-mono)] text-[22px] font-semibold tabular-nums text-fg">
          {feeRate ? `Tier ${feeRate.feeTier}` : "—"}
        </span>
        <span className="font-[var(--font-jetbrains-mono)] text-[11px] tabular-nums text-fg-muted">
          {feeRate
            ? `${(feeRate.makerFeeRate * 100).toFixed(3)}% / ${(feeRate.takerFeeRate * 100).toFixed(3)}%`
            : "maker / taker"}
        </span>
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-line/50 pt-2 text-[11px]">
        <span className="text-fg-dim">30d volume</span>
        <span className="font-[var(--font-jetbrains-mono)] tabular-nums text-fg-muted">
          {volume30d != null ? compactUsd(volume30d) : "—"}
        </span>
      </div>
    </div>
  );
}
