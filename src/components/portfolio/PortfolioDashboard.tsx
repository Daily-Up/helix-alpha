"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Stat } from "@/components/ui/Stat";
import { HeroStat, SubStat } from "@/components/ui/HeroStat";
import { StatSkeleton, TableSkeleton } from "@/components/ui/Skeleton";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { AssetCell } from "@/components/ui/AssetLogo";
import { Num } from "@/components/ui/Num";
import { Timestamp } from "@/components/ui/Timestamp";
import { Action } from "@/components/ui/Action";
import { LiveOrdersPanel } from "@/components/sodex/LiveOrdersPanel";
import { isPublicMode } from "@/lib/public-mode";
import { useBulkMountReveal } from "@/hooks/useMountReveal";
import { fmtPct, fmtSodexSymbol, fmtUsd } from "@/lib/format";
import { cn } from "@/components/ui/cn";

interface Settings {
  paper_starting_balance_usd: number;
  auto_trade_enabled: boolean;
}

interface Stats {
  starting_balance: number;
  realised_pnl: number;
  unrealised_pnl: number;
  equity: number;
  open_positions: number;
  closed_trades: number;
  winning_trades: number;
  win_rate: number;
}

interface OpenPos {
  id: string;
  asset_id: string;
  sodex_symbol: string;
  direction: "long" | "short";
  size_usd: number;
  entry_price: number;
  entry_time: number;
  stop_price: number | null;
  target_price: number | null;
  current_price: number | null;
  unrealised_pnl_usd: number | null;
  unrealised_pnl_pct: number | null;
}

interface ClosedTrade {
  id: string;
  asset_id: string;
  sodex_symbol: string;
  direction: "long" | "short";
  size_usd: number;
  entry_price: number;
  exit_price: number;
  exit_time: number;
  exit_reason: string;
  pnl_usd: number;
  pnl_pct: number;
}

interface PortfolioResponse {
  settings: Settings;
  stats: Stats;
  open: OpenPos[];
  closed: ClosedTrade[];
}

export function PortfolioDashboard() {
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    const r = await fetch("/api/data/portfolio");
    if (r.ok) setData(await r.json());
  }, []);

  useEffect(() => {
    fetchData();
    const t = setInterval(fetchData, 10_000); // refresh every 10s — live P&L
    return () => clearInterval(t);
  }, [fetchData]);

  const revealRef = useBulkMountReveal();

  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => <StatSkeleton key={i} />)}
        </div>
        <div className="rounded-md border border-line bg-surface">
          <TableSkeleton rows={4} cols={7} />
        </div>
      </div>
    );
  }

  const { stats, open, closed } = data;
  const equityChange = stats.equity - stats.starting_balance;
  const equityPct = (equityChange / stats.starting_balance) * 100;

  const closeTrade = async (id: string) => {
    setBusyId(id);
    await fetch("/api/trading/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trade_id: id }),
    });
    setBusyId(null);
    fetchData();
  };

  return (
    <div ref={revealRef} className="dash-crossfade-enter flex flex-col gap-4">
      {/* Headline: Equity. Other portfolio counters demoted below. */}
      <div className="mt-2 flex flex-col gap-6">
        <HeroStat
          label="Paper equity"
          value={fmtUsd(stats.equity)}
          change={`${equityChange >= 0 ? "+" : ""}${fmtUsd(equityChange)} · ${fmtPct(equityPct)}`}
          changeTone={
            equityChange > 0
              ? "positive"
              : equityChange < 0
                ? "negative"
                : "neutral"
          }
          sub={`from $${stats.starting_balance.toLocaleString()} starting`}
        />
        <div className="grid grid-cols-2 gap-x-10 md:max-w-[820px] md:grid-cols-4">
          <SubStat
            label="Realised P&L"
            value={fmtUsd(stats.realised_pnl)}
            sub={`${stats.closed_trades} trades`}
            tone={
              stats.realised_pnl > 0
                ? "positive"
                : stats.realised_pnl < 0
                  ? "negative"
                  : "neutral"
            }
          />
          <SubStat
            label="Unrealised P&L"
            value={fmtUsd(stats.unrealised_pnl)}
            sub={`${stats.open_positions} open`}
            tone={
              stats.unrealised_pnl > 0
                ? "positive"
                : stats.unrealised_pnl < 0
                  ? "negative"
                  : "neutral"
            }
          />
          <SubStat
            label="Win rate"
            value={`${(stats.win_rate * 100).toFixed(0)}%`}
            sub={`${stats.winning_trades}/${stats.closed_trades} winners`}
          />
          <SubStat
            label="Open positions"
            value={String(stats.open_positions)}
            sub="live mark-to-market"
          />
        </div>
      </div>

      {/* Live SoDEX orders for the connected account (mainnet). Renders only
          when a trading identity is present; otherwise the paper book below
          stands alone. */}
      <LiveOrdersPanel />

      {/* Open positions (paper simulation) */}
      <Card className="">
        <CardHeader>
          <CardTitle>Open Positions</CardTitle>
          <span className="text-xs text-fg-muted">
            live SoDEX prices · auto-refresh every 10s
          </span>
        </CardHeader>
        <CardBody className="p-0">
          {open.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-fg-muted">
              No open positions.
            </div>
          ) : (
            <DataTable<OpenPos>
              columns={[
                {
                  key: "asset",
                  header: "Asset",
                  role: "identifier",
                  render: (p) => (
                    <AssetCell
                      logoSymbol={p.sodex_symbol}
                      primary={
                        <span title={p.sodex_symbol}>
                          {fmtSodexSymbol(p.sodex_symbol)}
                          <span
                            className={cn(
                              "ml-1.5 text-[9px] uppercase tracking-wider",
                              p.direction === "long" ? "text-positive" : "text-negative",
                            )}
                          >
                            {p.direction}
                          </span>
                        </span>
                      }
                    />
                  ),
                },
                { key: "size", header: "Size", role: "context", num: (p) => p.size_usd, unit: "$" },
                { key: "entry", header: "Entry", role: "context", num: (p) => p.entry_price, unit: "$" },
                { key: "current", header: "Current", role: "context", num: (p) => p.current_price, unit: "$" },
                { key: "pnl", header: "P&L", role: "magnitude", num: (p) => p.unrealised_pnl_usd, unit: "$", sign: true, tone: "auto" },
                { key: "age", header: "Age", role: "context", render: (p) => <Timestamp ms={p.entry_time} /> },
                ...(isPublicMode()
                  ? []
                  : [
                      {
                        key: "act",
                        header: "",
                        role: "action",
                        render: (p) => (
                          <Action enabled={busyId !== p.id} tone="danger" onClick={() => closeTrade(p.id)}>
                            {busyId === p.id ? "Closing…" : "Close"}
                          </Action>
                        ),
                      } as Column<OpenPos>,
                    ]),
              ]}
              rows={open}
              getKey={(p) => p.id}
              minWidth={560}
            />
          )}
        </CardBody>
      </Card>

      {/* Closed trades */}
      <Card className="">
        <CardHeader>
          <CardTitle>Closed Trades</CardTitle>
          <span className="text-xs text-fg-muted">{closed.length} trades</span>
        </CardHeader>
        <CardBody className="p-0">
          {closed.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-fg-muted">
              No closed trades yet.
            </div>
          ) : (
            <DataTable<ClosedTrade>
              columns={[
                {
                  key: "asset",
                  header: "Asset",
                  role: "identifier",
                  render: (t) => (
                    <AssetCell
                      logoSymbol={t.sodex_symbol}
                      primary={
                        <span title={t.sodex_symbol}>
                          {fmtSodexSymbol(t.sodex_symbol)}
                          <span
                            className={cn(
                              "ml-1.5 text-[9px] uppercase tracking-wider",
                              t.direction === "long" ? "text-positive" : "text-negative",
                            )}
                          >
                            {t.direction}
                          </span>
                        </span>
                      }
                    />
                  ),
                },
                { key: "size", header: "Size", role: "context", num: (t) => t.size_usd, unit: "$" },
                {
                  key: "px",
                  header: "Entry → Exit",
                  role: "context",
                  render: (t) => (
                    <span className="whitespace-nowrap">
                      <Num value={t.entry_price} unit="$" tier="context" /> →{" "}
                      <Num value={t.exit_price} unit="$" tier="context" />
                    </span>
                  ),
                },
                { key: "pnl", header: "P&L", role: "magnitude", num: (t) => t.pnl_usd, unit: "$", sign: true, tone: "auto" },
                {
                  key: "reason",
                  header: "Reason",
                  role: "context",
                  align: "left",
                  render: (t) => <span className="text-fg-dim">{t.exit_reason}</span>,
                },
                { key: "closed", header: "Closed", role: "context", render: (t) => <Timestamp ms={t.exit_time} /> },
              ]}
              rows={closed}
              getKey={(t) => t.id}
              minWidth={560}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
