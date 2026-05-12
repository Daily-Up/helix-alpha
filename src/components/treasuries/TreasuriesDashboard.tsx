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
import { Stat } from "@/components/ui/Stat";
import { Badge } from "@/components/ui/Badge";

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
      const r = await fetch("/api/cron/ingest-btc-treasuries", {
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
      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Tracked treasuries"
          value={data.stats.total_companies}
          sub="public companies holding BTC"
        />
        <Stat
          label="Acquired BTC (30d)"
          value={fmtBtc(data.stats.net_btc_acquired_30d)}
          sub={`across ${data.stats.acquiring_companies_30d} companies`}
          tone={data.stats.net_btc_acquired_30d > 0 ? "positive" : "default"}
        />
        <Stat
          label="USD spent (30d, disclosed)"
          value={
            data.stats.total_acq_cost_30d_usd != null
              ? fmtUsdCompact(data.stats.total_acq_cost_30d_usd)
              : "—"
          }
          sub="some treasuries don't disclose cost"
          tone={
            (data.stats.total_acq_cost_30d_usd ?? 0) > 0 ? "accent" : "default"
          }
        />
        <Stat
          label="Total BTC held"
          value={fmtBtc(data.stats.total_btc_held_latest)}
          sub="aggregate latest snapshot"
        />
      </div>

      {/* Refresh */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-fg-dim">
          Source: SoSoValue /btc-treasuries
        </span>
        <button
          onClick={refresh}
          disabled={running}
          className="rounded border border-line px-2.5 py-1 text-xs text-fg-muted transition-colors hover:border-line-2 hover:text-fg disabled:cursor-wait disabled:opacity-50"
        >
          {running ? "Refreshing…" : "↻ Refresh from SoSoValue"}
        </button>
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
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-line bg-surface-2">
                <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                  <th className="px-3 py-2 text-left">#</th>
                  <th className="px-3 py-2 text-left">Ticker</th>
                  <th className="px-3 py-2 text-left">Company</th>
                  <th className="px-3 py-2 text-left">Listed</th>
                  <th className="px-3 py-2 text-right">BTC held</th>
                  <th className="px-3 py-2 text-right">Last buy</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.holders.map((h, i) => (
                  <tr
                    key={h.ticker}
                    className="text-xs transition-colors hover:bg-surface-2"
                  >
                    <td className="px-3 py-2 text-fg-dim">{i + 1}</td>
                    <td className="px-3 py-2 font-mono font-medium text-fg">
                      {h.ticker}
                    </td>
                    <td className="px-3 py-2 text-fg-muted">{h.name}</td>
                    <td className="px-3 py-2 text-[11px] text-fg-dim">
                      {h.list_location ?? "—"}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-fg">
                      {fmtBtc(h.btc_holding)}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-fg-muted">
                      {h.last_purchase_date}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-line bg-surface-2">
                <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Ticker</th>
                  <th className="px-3 py-2 text-left">Company</th>
                  <th className="px-3 py-2 text-right">BTC bought</th>
                  <th className="px-3 py-2 text-right">Holdings after</th>
                  <th className="px-3 py-2 text-right">Cost (USD)</th>
                  <th className="px-3 py-2 text-right">$/BTC</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.recent.map((p, i) => (
                  <tr
                    key={`${p.ticker}-${p.date}-${i}`}
                    className="text-xs transition-colors hover:bg-surface-2"
                  >
                    <td className="px-3 py-2 text-fg-muted whitespace-nowrap">
                      {p.date}
                    </td>
                    <td className="px-3 py-2 font-mono font-medium text-fg">
                      {p.ticker}
                    </td>
                    <td className="px-3 py-2 text-fg-muted">
                      {p.company_name}
                    </td>
                    <td className="tabular px-3 py-2 text-right">
                      <span
                        className={
                          p.btc_acq > 0
                            ? "text-positive"
                            : p.btc_acq < 0
                              ? "text-negative"
                              : "text-fg-muted"
                        }
                      >
                        {p.btc_acq > 0 ? "+" : ""}
                        {fmtBtc(p.btc_acq)}
                      </span>
                    </td>
                    <td className="tabular px-3 py-2 text-right text-fg">
                      {fmtBtc(p.btc_holding)}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-fg-muted">
                      {p.acq_cost_usd != null ? (
                        fmtUsdCompact(p.acq_cost_usd)
                      ) : (
                        <Badge tone="default">undisclosed</Badge>
                      )}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-fg-muted">
                      {p.avg_btc_cost_usd != null
                        ? `$${Math.round(p.avg_btc_cost_usd).toLocaleString()}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
