"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Stat } from "@/components/ui/Stat";
import { HeroStat, SubStat } from "@/components/ui/HeroStat";
import { Badge } from "@/components/ui/Badge";
import { StatSkeleton, TableSkeleton } from "@/components/ui/Skeleton";
import { useBulkMountReveal } from "@/hooks/useMountReveal";
import {
  fmtPct,
  fmtPrice,
  fmtRelative,
  fmtSodexSymbol,
  fmtUsd,
} from "@/lib/format";
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

      {/* Open positions */}
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
            <table className="w-full">
              <thead className="border-b border-line bg-surface-2">
                <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                  <th className="px-3 py-2 text-left">Asset</th>
                  <th className="px-3 py-2 text-left">Side</th>
                  <th className="px-3 py-2 text-right">Size</th>
                  <th className="px-3 py-2 text-right">Entry</th>
                  <th className="px-3 py-2 text-right">Current</th>
                  <th className="px-3 py-2 text-right">Stop</th>
                  <th className="px-3 py-2 text-right">Target</th>
                  <th className="px-3 py-2 text-right">P&L</th>
                  <th className="px-3 py-2 text-right">Age</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {open.map((p) => {
                  const pnl = p.unrealised_pnl_usd;
                  const pct = p.unrealised_pnl_pct;
                  return (
                    <tr
                      key={p.id}
                      className="text-xs transition-colors hover:bg-surface-2"
                    >
                      <td className="px-3 py-2">
                        <div
                          className="font-mono text-fg"
                          title={p.sodex_symbol}
                        >
                          {fmtSodexSymbol(p.sodex_symbol)}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          tone={p.direction === "long" ? "positive" : "negative"}
                          mono
                        >
                          {p.direction}
                        </Badge>
                      </td>
                      <td className="tabular px-3 py-2 text-right text-fg">
                        {fmtUsd(p.size_usd)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-fg-muted">
                        {fmtPrice(p.entry_price)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-fg">
                        {fmtPrice(p.current_price)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-fg-dim">
                        {fmtPrice(p.stop_price)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-fg-dim">
                        {fmtPrice(p.target_price)}
                      </td>
                      <td
                        className={cn(
                          "tabular px-3 py-2 text-right font-medium",
                          (pnl ?? 0) > 0
                            ? "text-positive"
                            : (pnl ?? 0) < 0
                              ? "text-negative"
                              : "text-fg-muted",
                        )}
                      >
                        {pnl != null ? fmtUsd(pnl) : "—"}
                        {pct != null ? (
                          <div className="text-[10px] font-normal">
                            {fmtPct(pct)}
                          </div>
                        ) : null}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-fg-dim">
                        {fmtRelative(p.entry_time)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => closeTrade(p.id)}
                          disabled={busyId === p.id}
                          className={cn(
                            "rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider",
                            busyId === p.id
                              ? "cursor-wait border-line text-fg-dim"
                              : "border-line text-fg-muted hover:border-negative/40 hover:text-negative",
                          )}
                        >
                          {busyId === p.id ? "Closing…" : "Close"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
            <table className="w-full">
              <thead className="border-b border-line bg-surface-2">
                <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                  <th className="px-3 py-2 text-left">Asset</th>
                  <th className="px-3 py-2 text-left">Side</th>
                  <th className="px-3 py-2 text-right">Size</th>
                  <th className="px-3 py-2 text-right">Entry → Exit</th>
                  <th className="px-3 py-2 text-right">P&L</th>
                  <th className="px-3 py-2 text-left">Reason</th>
                  <th className="px-3 py-2 text-right">Closed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {closed.map((t) => (
                  <tr
                    key={t.id}
                    className="text-xs transition-colors hover:bg-surface-2"
                  >
                    <td
                      className="px-3 py-2 font-mono text-fg"
                      title={t.sodex_symbol}
                    >
                      {fmtSodexSymbol(t.sodex_symbol)}
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        tone={t.direction === "long" ? "positive" : "negative"}
                        mono
                      >
                        {t.direction}
                      </Badge>
                    </td>
                    <td className="tabular px-3 py-2 text-right text-fg">
                      {fmtUsd(t.size_usd)}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-fg-muted">
                      {fmtPrice(t.entry_price)} → {fmtPrice(t.exit_price)}
                    </td>
                    <td
                      className={cn(
                        "tabular px-3 py-2 text-right font-medium",
                        t.pnl_usd > 0
                          ? "text-positive"
                          : t.pnl_usd < 0
                            ? "text-negative"
                            : "text-fg-muted",
                      )}
                    >
                      {fmtUsd(t.pnl_usd)}
                      <div className="text-[10px] font-normal">
                        {fmtPct(t.pnl_pct)}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-fg-dim">
                      {t.exit_reason}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-fg-dim">
                      {fmtRelative(t.exit_time)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
