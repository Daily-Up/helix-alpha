"use client";

/**
 * /treasuries — corporate BTC accumulation ledger.
 *
 * "Smart money" lens on BTC: tracks the 56 publicly-listed companies
 * holding BTC on balance sheet (MSTR, MARA, Metaplanet, etc.) and
 * their dated purchase events. Pulls directly from SoSoValue's
 * /btc-treasuries surface.
 */

import { useEffect, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { HeroStat, SubStat } from "@/components/ui/HeroStat";
import { isPublicMode } from "@/lib/public-mode";
import { DataTable } from "@/components/ui/DataTable";
import { AssetCell } from "@/components/ui/AssetLogo";

interface Stats {
  total_companies: number;
  acquiring_companies_30d: number;
  net_btc_acquired_30d: number;
  total_btc_held_latest: number;
  total_acq_cost_30d_usd: number | null;
}

interface Holder {
  ticker: string;
  name: string;
  list_location: string | null;
  btc_holding: number;
  last_purchase_date: string;
}

interface Purchase {
  ticker: string;
  company_name: string;
  date: string;
  btc_holding: number;
  btc_acq: number;
  acq_cost_usd: number | null;
  avg_btc_cost_usd: number | null;
}

interface ApiResp {
  stats: Stats;
  holders: Holder[];
  recent: Purchase[];
}

function fmtUsdCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${n < 0 ? "-" : ""}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${n < 0 ? "-" : ""}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${n < 0 ? "-" : ""}$${(abs / 1e3).toFixed(1)}K`;
  return `${n < 0 ? "-" : ""}$${abs.toFixed(0)}`;
}

function fmtBtc(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function TreasuriesDashboard() {
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setError(null);
    const r = await fetch("/api/data/treasuries");
    const j = (await r.json()) as ApiResp;
    setData(j);
  };

  useEffect(() => {
    fetchData().finally(() => setLoading(false));
  }, []);

  const refresh = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await fetch("/api/public/refresh-treasuries", {
        method: "POST",
      });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error ?? "ingest failed");
      } else {
        await fetchData();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setRunning(false);
    }
  };

  if (loading && !data) {
    return <div className="text-sm text-fg-dim">Loading treasury ledger…</div>;
  }
  if (!data) return null;

  return (
    <div className="flex flex-col gap-5">
      {/* Stats — headline: Total BTC held; the rest demoted to supporting. */}
      <div className="mt-2 flex flex-col gap-6">
        <HeroStat
          label="Total BTC held"
          value={fmtBtc(data.stats.total_btc_held_latest)}
          sub={`aggregate across ${data.stats.total_companies} tracked public companies`}
        />
        <div className="grid grid-cols-2 gap-x-10 md:max-w-[620px] md:grid-cols-3">
          <SubStat
            label="Acquired BTC (30d)"
            value={fmtBtc(data.stats.net_btc_acquired_30d)}
            sub={`across ${data.stats.acquiring_companies_30d} companies`}
            tone={data.stats.net_btc_acquired_30d > 0 ? "positive" : "neutral"}
          />
          <SubStat
            label="USD spent (30d)"
            value={
              data.stats.total_acq_cost_30d_usd != null
                ? fmtUsdCompact(data.stats.total_acq_cost_30d_usd)
                : "—"
            }
            sub="disclosed cost only"
          />
          <SubStat
            label="Tracked treasuries"
            value={String(data.stats.total_companies)}
            sub="public companies holding BTC"
          />
        </div>
      </div>

      {/* Refresh */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-fg-dim">
          Source: SoSoValue /btc-treasuries
        </span>
        {!isPublicMode() ? (
          <button
            onClick={refresh}
            disabled={running}
            className="rounded border border-line px-2.5 py-1 text-xs text-fg-muted transition-colors hover:border-line-2 hover:text-fg disabled:cursor-wait disabled:opacity-50"
          >
            {running ? "Refreshing…" : "↻ Refresh from SoSoValue"}
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="rounded border border-negative/40 bg-negative/10 px-3 py-2 text-xs text-negative">
          {error}
        </div>
      ) : null}

      {/* Top holders */}
      <Card>
        <CardHeader>
          <CardTitle>Top holders</CardTitle>
          <span className="text-[11px] text-fg-dim">
            {data.holders.length} of {data.stats.total_companies}
          </span>
        </CardHeader>
        <CardBody className="!p-0">
          <DataTable<Holder & { rank: number }>
            columns={[
              { key: "rank", header: "#", role: "context", align: "left", render: (h) => h.rank },
              {
                key: "ticker",
                header: "Company",
                role: "identifier",
                render: (h) => (
                  <AssetCell logoSymbol={h.ticker} primary={h.ticker} secondary={h.name} />
                ),
              },
              { key: "listed", header: "Listed", role: "context", align: "left", render: (h) => h.list_location ?? "—" },
              { key: "btc", header: "BTC held", role: "magnitude", num: (h) => h.btc_holding, unit: "BTC" },
              { key: "lastbuy", header: "Last buy", role: "context", render: (h) => h.last_purchase_date },
            ]}
            rows={data.holders.map((h, i) => ({ ...h, rank: i + 1 }))}
            getKey={(h) => h.ticker}
            minWidth={560}
          />
        </CardBody>
      </Card>

      {/* Recent purchases */}
      <Card>
        <CardHeader>
          <CardTitle>Recent purchase events</CardTitle>
          <span className="text-[11px] text-fg-dim">
            last {data.recent.length}, newest first
          </span>
        </CardHeader>
        <CardBody className="!p-0">
          <DataTable<Purchase>
            columns={[
              { key: "date", header: "Date", role: "context", align: "left", render: (p) => p.date },
              {
                key: "ticker",
                header: "Company",
                role: "identifier",
                render: (p) => (
                  <AssetCell logoSymbol={p.ticker} primary={p.ticker} secondary={p.company_name} />
                ),
              },
              { key: "btc", header: "BTC bought", role: "magnitude", num: (p) => p.btc_acq, unit: "BTC", sign: true, tone: "auto" },
              { key: "held", header: "Holdings after", role: "context", num: (p) => p.btc_holding, unit: "BTC" },
              { key: "cost", header: "Cost", role: "context", num: (p) => p.acq_cost_usd, unit: "$" },
            ]}
            rows={data.recent}
            getKey={(p, i) => `${p.ticker}-${p.date}-${i}`}
            minWidth={640}
          />
        </CardBody>
      </Card>
    </div>
  );
}
