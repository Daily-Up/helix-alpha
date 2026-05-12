"use client";

import { fmtUsd } from "@/lib/format";
import { cn } from "@/components/ui/cn";

export interface FundRow {
  ticker: string;
  name: string;
  exchange: string;
  net_inflow: number | null;
  cum_inflow: number | null;
  net_assets: number | null;
  prem_dsc: number | null;
  value_traded: number | null;
  date: string;
}

/**
 * Per-fund leaderboard table. Sorted by AUM by default (largest fund first).
 * Highlights the day's inflow leader / outflow leader.
 */
export function FundLeaderboard({ funds }: { funds: FundRow[] }) {
  if (funds.length === 0) {
    return (
      <div className="rounded border border-line bg-surface p-6 text-center text-sm text-fg-muted">
        No fund data yet — run ETF ingest.
      </div>
    );
  }

  // Find best/worst inflow for the day
  const inflows = funds
    .map((f) => f.net_inflow ?? 0)
    .filter((n) => Number.isFinite(n));
  const maxIn = Math.max(...inflows);
  const minIn = Math.min(...inflows);

  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface">
      <table className="w-full">
        <thead className="border-b border-line bg-surface-2">
          <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
            <th className="px-3 py-2 text-left">Ticker</th>
            <th className="px-3 py-2 text-left">Name</th>
            <th className="px-3 py-2 text-right">Daily Inflow</th>
            <th className="px-3 py-2 text-right">AUM</th>
            <th className="px-3 py-2 text-right">Cum Inflow</th>
            <th className="px-3 py-2 text-right">Prem/Disc</th>
            <th className="px-3 py-2 text-right">Volume</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {funds.map((f) => {
            const flow = f.net_inflow ?? 0;
            const isMax = flow > 0 && flow === maxIn;
            const isMin = flow < 0 && flow === minIn;
            return (
              <tr
                key={f.ticker}
                className="text-xs transition-colors hover:bg-surface-2"
              >
                <td className="px-3 py-2">
                  <div className="font-mono font-medium text-fg">
                    {f.ticker}
                  </div>
                  {isMax ? (
                    <div className="text-[10px] uppercase text-positive">
                      ▲ top inflow
                    </div>
                  ) : isMin ? (
                    <div className="text-[10px] uppercase text-negative">
                      ▼ top outflow
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-fg-muted">{f.name}</td>
                <td
                  className={cn(
                    "tabular px-3 py-2 text-right font-medium",
                    flow > 0
                      ? "text-positive"
                      : flow < 0
                        ? "text-negative"
                        : "text-fg-muted",
                  )}
                >
                  {fmtUsd(f.net_inflow)}
                </td>
                <td className="tabular px-3 py-2 text-right text-fg">
                  {fmtUsd(f.net_assets)}
                </td>
                <td className="tabular px-3 py-2 text-right text-fg-muted">
                  {fmtUsd(f.cum_inflow)}
                </td>
                <td className="tabular px-3 py-2 text-right text-fg-muted">
                  {f.prem_dsc != null
                    ? `${(f.prem_dsc * 100).toFixed(3)}%`
                    : "—"}
                </td>
                <td className="tabular px-3 py-2 text-right text-fg-muted">
                  {fmtUsd(f.value_traded)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
