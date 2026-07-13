"use client";

import { DataTable, type Column } from "@/components/ui/DataTable";
import { AssetCell } from "@/components/ui/AssetLogo";

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
 * Per-fund leaderboard. Daily inflow is the story, so it ENCODES its
 * magnitude as a diverging bar (green in / red out) — which also retires
 * the "▲ top inflow / ▼ top outflow" badges: the biggest row now looks
 * biggest without a label apologising for the hierarchy.
 */
export function FundLeaderboard({ funds }: { funds: FundRow[] }) {
  if (funds.length === 0) {
    return (
      <div className="rounded border border-line bg-surface p-6 text-center text-sm text-fg-muted">
        No fund data yet — run ETF ingest.
      </div>
    );
  }

  const columns: Column<FundRow>[] = [
    {
      key: "ticker",
      header: "Fund",
      role: "identifier",
      render: (f) => (
        <AssetCell logoSymbol={f.ticker} primary={f.ticker} secondary={f.name} />
      ),
    },
    { key: "flow", header: "Daily Inflow", role: "magnitude", num: (f) => f.net_inflow, unit: "$", sign: true, tone: "auto" },
    { key: "aum", header: "AUM", role: "magnitude", num: (f) => f.net_assets, unit: "$" },
    { key: "cum", header: "Cum Inflow", role: "context", num: (f) => f.cum_inflow, unit: "$" },
    { key: "prem", header: "Prem/Disc", role: "context", num: (f) => (f.prem_dsc != null ? f.prem_dsc * 100 : null), unit: "%", sign: true },
  ];

  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface">
      <DataTable columns={columns} rows={funds} getKey={(f) => f.ticker} minWidth={560} />
    </div>
  );
}
