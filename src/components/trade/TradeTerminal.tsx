"use client";

/**
 * TradeTerminal — the full TrueNorth-style terminal.
 *
 * Market bar (asset picker + live stats) · candlestick chart · SoDEX order
 * book · Buy/Long–Sell/Short order panel. The "Setup" button runs Helix's
 * news-grounded /api/setup and draws its support/resistance levels straight
 * onto the chart — the auditable edge over a generic TA terminal.
 */

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/components/ui/cn";
import { SetupCard, type SetupResponse } from "./SetupCard";
import { PriceChart } from "./PriceChart";
import { OrderBook, type BookLevel } from "./OrderBook";
import { OrderPanel } from "./OrderPanel";

export interface TerminalAsset {
  id: string;
  symbol: string;
  name: string;
  kind: string;
  sodex_symbol: string | null;
  market: "spot" | "perp" | null;
}

interface Ticker {
  lastPx: string;
  quoteVolume: string;
  highPx: string;
  lowPx: string;
  changePct: number;
}

const GROUPS: Array<{ label: string; kinds: string[] }> = [
  { label: "Crypto", kinds: ["token", "rwa"] },
  { label: "Equities", kinds: ["stock"] },
  { label: "Indices", kinds: ["index"] },
  { label: "Other", kinds: ["treasury", "macro"] },
];

const fmt = (v: number | null, d = 2) =>
  v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: d });

export function TradeTerminal({ assets }: { assets: TerminalAsset[] }) {
  const [assetId, setAssetId] = useState<string>(
    () => assets.find((a) => a.id === "tok-btc")?.id ?? assets[0]?.id ?? "",
  );
  const selected = assets.find((a) => a.id === assetId) ?? null;
  const sodexSymbol = selected?.sodex_symbol ?? null;
  const market = selected?.market ?? "spot";

  // ── Live market data (ticker + book), polled ──
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [bids, setBids] = useState<BookLevel[]>([]);
  const [asks, setAsks] = useState<BookLevel[]>([]);
  const [mktLoading, setMktLoading] = useState(false);

  useEffect(() => {
    if (!sodexSymbol) return;
    let cancelled = false;
    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      setMktLoading(true);
      try {
        const r = await fetch(
          `/api/sodex/market?symbol=${encodeURIComponent(sodexSymbol)}&market=${market}`,
        );
        const j = await r.json();
        if (cancelled || !j.ok) return;
        setTicker(j.ticker);
        setBids(j.bids ?? []);
        setAsks(j.asks ?? []);
      } catch {
        /* keep last good values */
      } finally {
        if (!cancelled) setMktLoading(false);
      }
    };
    setTicker(null);
    setBids([]);
    setAsks([]);
    load();
    const t = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sodexSymbol, market]);

  const markPrice = ticker ? Number(ticker.lastPx) : null;

  // ── Setup ──
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  // Only show setup levels on the chart when the setup is for THIS asset.
  const levels =
    setup && setup.asset.id === assetId ? setup.setup.key_levels : undefined;

  async function runSetup() {
    if (!assetId) return;
    setSetupLoading(true);
    setSetupError(null);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetId }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? `Setup failed (${res.status})`);
      setSetup(json as SetupResponse);
    } catch (e) {
      setSetupError((e as Error).message);
    } finally {
      setSetupLoading(false);
    }
  }

  const grouped = useMemo(
    () =>
      GROUPS.map((g) => ({
        label: g.label,
        items: assets.filter((a) => g.kinds.includes(a.kind)),
      })).filter((g) => g.items.length > 0),
    [assets],
  );

  const changePct = ticker?.changePct ?? null;

  return (
    <div className="flex flex-col gap-4">
      {/* ── Market bar ── */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-line bg-surface px-4 py-3">
        <select
          value={assetId}
          onChange={(e) => {
            setAssetId(e.target.value);
            setSetupError(null);
          }}
          className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm font-medium text-fg outline-none focus:border-accent/50"
        >
          {grouped.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.items.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.symbol} · {a.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        <Stat label="Mark" value={fmt(markPrice, markPrice != null && markPrice < 10 ? 5 : 2)} />
        <Stat
          label="24h"
          value={changePct != null ? `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%` : "—"}
          tone={changePct == null ? "default" : changePct >= 0 ? "positive" : "negative"}
        />
        <Stat
          label="24h Vol"
          value={ticker ? `$${fmt(Number(ticker.quoteVolume) || 0, 0)}` : "—"}
        />
        {selected?.market ? (
          <span className="rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-dim">
            {selected.market}
          </span>
        ) : null}

        <button
          onClick={runSetup}
          disabled={setupLoading}
          className={cn(
            "dash-btn-primary ml-auto inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-[13px] font-medium transition-colors",
            setupLoading
              ? "cursor-wait border-line bg-surface-2 text-fg-dim"
              : "border-accent/50 bg-accent/20 text-accent-2 hover:bg-accent/30",
          )}
        >
          {setupLoading ? "Reading the tape…" : "⚡ Run Setup"}
        </button>
      </div>

      {/* ── Terminal grid: (chart + book) | order panel ── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_250px]">
            <div className="rounded-xl border border-line bg-surface p-3">
              {sodexSymbol ? (
                <PriceChart symbol={sodexSymbol} market={market} levels={levels} />
              ) : (
                <div className="flex h-[360px] items-center justify-center text-sm text-fg-dim">
                  No SoDEX market for this asset.
                </div>
              )}
            </div>
            <OrderBook bids={bids} asks={asks} markPrice={markPrice} loading={mktLoading} />
          </div>

          {/* Setup output */}
          {setupError ? (
            <div className="rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-sm text-negative">
              {setupError}
            </div>
          ) : null}
          {setupLoading ? (
            <div className="rounded-xl border border-line bg-surface px-5 py-8 text-center text-sm text-fg-dim">
              Pulling {selected?.symbol} news + price, thinking through the setup…
            </div>
          ) : null}
          {setup && setup.asset.id === assetId ? (
            <SetupCard data={setup} />
          ) : !setupLoading && !setupError ? (
            <div className="rounded-xl border border-dashed border-line px-5 py-8 text-center text-sm text-fg-muted">
              Run a Setup — Helix reads the latest SoSoValue news and price
              action, calls the bias and levels, and draws them on the chart.
            </div>
          ) : null}
        </div>

        {/* Right rail: order ticket */}
        {selected && sodexSymbol ? (
          <OrderPanel
            symbol={selected.symbol}
            sodexSymbol={sodexSymbol}
            market={selected.market}
            markPrice={markPrice}
          />
        ) : null}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "positive" | "negative";
}) {
  return (
    <div className="flex flex-col">
      <span className="font-[var(--font-jetbrains-mono)] text-[9px] uppercase tracking-wider text-fg-dim">
        {label}
      </span>
      <span
        className={cn(
          "font-[var(--font-jetbrains-mono)] text-[13px]",
          tone === "positive" && "text-positive",
          tone === "negative" && "text-negative",
          tone === "default" && "text-fg",
        )}
      >
        {value}
      </span>
    </div>
  );
}
