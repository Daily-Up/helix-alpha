"use client";

import { useEffect, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Stat } from "@/components/ui/Stat";
import { fmtUsd } from "@/lib/format";
import { cn } from "@/components/ui/cn";
import { AumChart, type AumChartRow } from "./AumChart";
import { InflowChart, type InflowChartRow } from "./InflowChart";
import { FundLeaderboard, type FundRow } from "./FundLeaderboard";

interface EtfFlowsResponse {
  symbol: string;
  country_code: string;
  totals: {
    date: string;
    total_net_inflow: number;
    cum_net_inflow: number;
    total_net_assets: number;
    total_value_traded: number;
  } | null;
  aggregate: Array<{
    date: string;
    total_net_inflow: number | null;
    cum_net_inflow: number | null;
    total_net_assets: number | null;
    total_value_traded?: number | null;
  }>;
  funds: FundRow[];
}

const SYMBOLS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "LINK", "LTC", "HBAR", "AVAX", "DOT"];

export function EtfDashboard() {
  const [symbol, setSymbol] = useState<string>("BTC");
  const [data, setData] = useState<EtfFlowsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/data/etf-flows?symbol=${symbol}&country_code=US&days=30`)
      .then((r) => r.json())
      .then((d: EtfFlowsResponse) => setData(d))
      .finally(() => setLoading(false));
  }, [symbol]);

  const totals = data?.totals;
  const inflowChartData: InflowChartRow[] = (data?.aggregate ?? []).map((r) => ({
    date: r.date,
    total_net_inflow: r.total_net_inflow,
  }));
  const aumChartData: AumChartRow[] = (data?.aggregate ?? []).map((r) => ({
    date: r.date,
    total_net_assets: r.total_net_assets,
  }));

  return (
    <div className="flex flex-col gap-4">
      {/* Symbol selector */}
      <div className="flex flex-wrap items-center gap-1">
        {SYMBOLS.map((s) => (
          <button
            key={s}
            onClick={() => setSymbol(s)}
            className={cn(
              "h-7 rounded border px-2.5 text-xs font-medium transition-colors",
              s === symbol
                ? "border-accent/40 bg-accent/15 text-accent-2"
                : "border-line bg-surface text-fg-muted hover:border-line-2 hover:text-fg",
            )}
          >
            {s}
          </button>
        ))}
        <span className="ml-auto text-xs text-fg-dim">
          {loading
            ? "loading…"
            : data
              ? `${data.aggregate.length} days · ${data.funds.length} funds`
              : null}
        </span>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label={`${symbol} Daily Net Flow`}
          value={fmtUsd(totals?.total_net_inflow)}
          sub={totals?.date}
          tone={
            (totals?.total_net_inflow ?? 0) >= 0 ? "positive" : "negative"
          }
        />
        <Stat
          label={`${symbol} ETF AUM`}
          value={fmtUsd(totals?.total_net_assets)}
          sub="all funds combined"
          tone="accent"
        />
        <Stat
          label="Cum Net Inflow"
          value={fmtUsd(totals?.cum_net_inflow)}
          sub="since launch"
        />
        <Stat
          label="Daily Volume Traded"
          value={fmtUsd(totals?.total_value_traded)}
          sub={totals?.date}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Daily Net Inflow · 30 days</CardTitle>
            <span className="text-xs text-fg-muted">{symbol} spot ETFs (US)</span>
          </CardHeader>
          <CardBody>
            {inflowChartData.length > 0 ? (
              <InflowChart data={inflowChartData} />
            ) : (
              <EmptyState />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Total Net Assets · 30 days</CardTitle>
            <span className="text-xs text-fg-muted">cumulative AUM</span>
          </CardHeader>
          <CardBody>
            {aumChartData.length > 0 ? (
              <AumChart data={aumChartData} />
            ) : (
              <EmptyState />
            )}
          </CardBody>
        </Card>
      </div>

      {/* Per-fund table */}
      <Card>
        <CardHeader>
          <CardTitle>Per-Fund Breakdown · {symbol}</CardTitle>
          <span className="text-xs text-fg-muted">
            sorted by AUM · latest snapshot
          </span>
        </CardHeader>
        <CardBody className="p-0">
          <FundLeaderboard funds={data?.funds ?? []} />
        </CardBody>
      </Card>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-72 items-center justify-center text-sm text-fg-muted">
      No data yet — run{" "}
      <code className="mx-1 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
        npm run ingest:all
      </code>
    </div>
  );
}
