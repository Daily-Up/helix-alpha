"use client";

/**
 * FundCard — one SoDEX Wealth product in the catalog grid. Shows the headline
 * metric (APY for yield funds, else 1-year / since-inception return), 24h
 * move, market status, and a link out to SoDEX to invest. Click opens the
 * detail modal (price chart + full metrics). Numbers are straight from the
 * SoDEX Wealth API; a missing value renders as "—", never a guess.
 */

import { cn } from "@/components/ui/cn";
import { fmtPct } from "@/lib/format";
import type { WealthFundView } from "@/lib/wealth/types";
import { WealthSparkline } from "./WealthSparkline";

function signClass(n: number | null): string {
  if (n == null) return "text-fg-dim";
  return n >= 0 ? "text-positive" : "text-negative";
}

export function FundCard({
  fund,
  flagged,
  onSelect,
}: {
  fund: WealthFundView;
  flagged: boolean;
  onSelect: () => void;
}) {
  const status = fund.marketStatus;
  return (
    <div
      className="group relative flex cursor-pointer flex-col justify-between rounded-lg border border-line bg-surface p-3.5 transition-colors hover:border-line-2 hover:bg-surface-2/30"
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}
    >
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13.5px] font-medium text-fg">
                {fund.displayName}
              </span>
              {flagged && (
                <span
                  title="This fund has a live suggestion"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                />
              )}
            </div>
            <div className="font-[var(--font-jetbrains-mono)] text-[10.5px] text-fg-dim">
              {fund.symbol}
            </div>
          </div>
          {status && (
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
                status === "TRADING"
                  ? "bg-positive/15 text-positive"
                  : "bg-surface-2 text-fg-dim",
              )}
            >
              {status === "TRADING" ? "Open" : status === "CLOSED" ? "Closed" : status}
            </span>
          )}
        </div>

        {fund.blurb && (
          <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-snug text-fg-muted">
            {fund.blurb}
          </p>
        )}
      </div>

      <div className="mt-3 flex items-end justify-between">
        <div>
          <div className="text-[9.5px] uppercase tracking-wider text-fg-dim">
            {fund.headlineLabel}
          </div>
          <div
            className={cn(
              "font-[var(--font-jetbrains-mono)] text-[18px] font-semibold tabular-nums",
              signClass(fund.headlineValue),
            )}
          >
            {fund.headlineValue == null ? "—" : fmtPct(fund.headlineValue)}
          </div>
        </div>
        {fund.changePct != null && !fund.isYield && (
          <div className="text-right">
            <div className="text-[9.5px] uppercase tracking-wider text-fg-dim">24h</div>
            <div
              className={cn(
                "font-[var(--font-jetbrains-mono)] text-[12px] tabular-nums",
                signClass(fund.changePct),
              )}
            >
              {fmtPct(fund.changePct)}
            </div>
          </div>
        )}
      </div>

      {/* 1-month sparkline */}
      <div className="mt-2.5">
        <WealthSparkline fundId={fund.fundId} />
      </div>

      <div className="mt-2 flex items-center justify-between border-t border-line pt-2.5">
        <span className="text-[10.5px] text-fg-dim group-hover:text-fg-muted">
          View details
        </span>
        {status === "CLOSED" ? (
          <span
            title="Market closed — open the details to invest on SoDEX"
            className="cursor-not-allowed rounded border border-line bg-surface-2/60 px-2.5 py-1 text-[11px] font-medium text-fg-dim"
          >
            Closed
          </span>
        ) : (
          <a
            href={fund.investUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="rounded border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent-2 transition-colors hover:bg-accent/20"
          >
            Invest ↗
          </a>
        )}
      </div>
    </div>
  );
}
