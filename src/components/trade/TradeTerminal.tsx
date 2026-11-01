"use client";

/**
 * TradeTerminal — exchange-grade terminal (Arcus/TrueNorth style).
 *
 * Header: asset identity + picker, big price, 24h stats. Body: candlestick
 * + volume chart with a live SoDEX order book beside it, and a Buy/Long–
 * Sell/Short order ticket on the right rail. "Setup" runs Helix's
 * news-grounded call and draws its levels onto the chart.
 */

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/components/ui/cn";
import { AssetLogo } from "@/components/ui/AssetLogo";
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
  change: string;
  changePct: number;
}

const GROUPS: Array<{ label: string; kinds: string[] }> = [
  { label: "Crypto", kinds: ["token", "rwa"] },
  { label: "Equities", kinds: ["stock"] },
  { label: "Indices", kinds: ["index"] },
  { label: "Other", kinds: ["treasury", "macro"] },
];

const fmt = (v: number | null, d = 2) =>
  v == null
    ? "—"
    : v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtCompact = (v: number | null) =>
  v == null
    ? "—"
    : v >= 1e9
      ? `${(v / 1e9).toFixed(2)}B`
      : v >= 1e6
        ? `${(v / 1e6).toFixed(2)}M`
        : v >= 1e3
          ? `${(v / 1e3).toFixed(1)}K`
          : v.toFixed(0);

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
  const digits = markPrice != null && markPrice < 10 ? 4 : 2;
  const changeAbs = ticker ? Number(ticker.change) : null;
  const changePct = ticker?.changePct ?? null;
  const up = (changePct ?? 0) >= 0;

  // ── Setup ──
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
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

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      {/* ── Header bar ── */}
      <div className="flex flex-wrap items-center gap-x-7 gap-y-3 border-b border-line bg-surface-2/40 px-4 py-3">
        {/* Identity + picker */}
        <div className="flex items-center gap-2.5">
          {selected ? <AssetLogo symbol={selected.symbol} size={30} /> : null}
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <div className="relative inline-flex items-center">
                <select
                  value={assetId}
                  onChange={(e) => {
                    setAssetId(e.target.value);
                    setSetupError(null);
                  }}
                  className="cursor-pointer appearance-none bg-transparent pr-5 text-[17px] font-semibold text-fg outline-none"
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
                <span className="pointer-events-none absolute right-0 text-fg-dim">▾</span>
              </div>
              {selected?.market ? (
                <span className="rounded border border-line bg-surface px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-fg-dim">
                  {selected.market}
                </span>
              ) : null}
            </div>
            <span className="text-[11px] text-fg-dim">{selected?.name}</span>
          </div>
        </div>

        {/* Price */}
        <div className="flex flex-col">
          <span className="font-[var(--font-jetbrains-mono)] text-[22px] font-medium leading-none text-fg">
            {markPrice != null ? `$${fmt(markPrice, digits)}` : "—"}
          </span>
          <span
            className={cn(
              "font-[var(--font-jetbrains-mono)] text-[12px]",
              up ? "text-positive" : "text-negative",
            )}
          >
            {changeAbs != null
              ? `${changeAbs >= 0 ? "+" : ""}${fmt(changeAbs, digits)}`
              : "—"}{" "}
            {changePct != null ? `(${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)` : ""}
          </span>
        </div>

        {/* Stats strip */}
        <div className="flex items-center gap-6">
          <HStat label="24h High" value={ticker ? fmt(Number(ticker.highPx), digits) : "—"} />
          <HStat label="24h Low" value={ticker ? fmt(Number(ticker.lowPx), digits) : "—"} />
          <HStat
            label="24h Volume"
            value={ticker ? `$${fmtCompact(Number(ticker.quoteVolume))}` : "—"}
          />
        </div>

        <button
          onClick={runSetup}
          disabled={setupLoading || !sodexSymbol}
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-[13px] font-semibold transition-colors",
            setupLoading
              ? "cursor-wait border-line bg-surface text-fg-dim"
              : "border-accent/50 bg-accent/20 text-accent-2 hover:bg-accent/30",
          )}
        >
          {setupLoading ? "Reading the tape…" : "⚡ AI Setup"}
        </button>
      </div>

      {/* ── Body: chart | book | ticket ── */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_236px] xl:grid-cols-[minmax(0,1fr)_236px_300px]">
        {/* Chart */}
        <div className="border-line px-3 py-2 lg:border-r">
          {sodexSymbol ? (
            <PriceChart
              symbol={sodexSymbol}
              label={`${selected?.symbol ?? ""} · ${market === "perp" ? "perp" : "spot"} · SoDEX`}
              market={market}
              levels={levels}
            />
          ) : (
            <div className="flex h-[420px] items-center justify-center text-sm text-fg-dim">
              No SoDEX market for this asset.
            </div>
          )}
        </div>

        {/* Order book */}
        <div className="border-t border-line lg:border-t-0">
          <OrderBook
            bids={bids}
            asks={asks}
            markPrice={markPrice}
            loading={mktLoading}
            symbol={selected?.symbol ?? ""}
          />
        </div>

        {/* Order ticket */}
        <div className="border-t border-line xl:border-l xl:border-t-0">
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

      {/* ── Setup output ── */}
      {(setup && setup.asset.id === assetId) || setupLoading || setupError ? (
        <div className="border-t border-line p-4">
          {setupError ? (
            <div className="rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-sm text-negative">
              {setupError}
            </div>
          ) : setupLoading ? (
            <div className="rounded-xl border border-line bg-surface-2/40 px-5 py-8 text-center text-sm text-fg-dim">
              Pulling {selected?.symbol} news + price, thinking through the setup…
            </div>
          ) : setup ? (
            <SetupCard data={setup} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function HStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-fg-dim">{label}</span>
      <span className="font-[var(--font-jetbrains-mono)] text-[12px] text-fg-muted">{value}</span>
    </div>
  );
}
