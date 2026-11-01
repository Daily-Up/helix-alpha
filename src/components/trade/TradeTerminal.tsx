"use client";

/**
 * TradeTerminal — exchange-grade perp/spot terminal (TrueNorth/Arcus style).
 *
 * Header carries the full SoDEX stat row (Mark · Oracle · 24h Change · 24h
 * Volume · Open Interest · Funding/Countdown for perps). Body: candlestick
 * + volume chart, live SoDEX order book (Price/Size/Total), and a
 * Cross-leverage order ticket. "AI Setup" runs Helix's news-grounded call
 * and draws its levels on the chart. Bottom: positions/balances tabs.
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
  // perps-only
  markPrice?: string;
  indexPrice?: string;
  openInterest?: string;
  fundingRate?: string;
  nextFundingTime?: number;
}

const GROUPS: Array<{ label: string; kinds: string[] }> = [
  { label: "Crypto", kinds: ["token", "rwa"] },
  { label: "Equities", kinds: ["stock"] },
  { label: "Indices", kinds: ["index"] },
  { label: "Other", kinds: ["treasury", "macro"] },
];

const num = (v: string | undefined) => (v == null ? null : Number(v));
const fmt = (v: number | null, d = 2) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtUsd = (v: number | null) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : v >= 1e9
      ? `$${(v / 1e9).toFixed(2)}B`
      : v >= 1e6
        ? `$${(v / 1e6).toFixed(2)}M`
        : v >= 1e3
          ? `$${(v / 1e3).toFixed(2)}K`
          : `$${v.toFixed(0)}`;

const BOTTOM_TABS = ["Positions", "Balances", "Open Orders", "Trade History"] as const;

export function TradeTerminal({ assets }: { assets: TerminalAsset[] }) {
  const [assetId, setAssetId] = useState<string>(
    () => assets.find((a) => a.id === "tok-btc")?.id ?? assets[0]?.id ?? "",
  );
  const selected = assets.find((a) => a.id === assetId) ?? null;
  const sodexSymbol = selected?.sodex_symbol ?? null;
  const market = selected?.market ?? "spot";
  const isPerp = market === "perp";

  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [bids, setBids] = useState<BookLevel[]>([]);
  const [asks, setAsks] = useState<BookLevel[]>([]);
  const [mktLoading, setMktLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [bottomTab, setBottomTab] = useState<(typeof BOTTOM_TABS)[number]>("Positions");

  // 1s clock for the funding countdown.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

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

  // Mark = perp mark price, else last. Everything anchors to this.
  const mark = num(ticker?.markPrice) ?? num(ticker?.lastPx);
  const digits = mark != null && mark < 10 ? 4 : 2;
  const oracle = num(ticker?.indexPrice);
  const changeAbs = num(ticker?.change);
  const changePct = ticker?.changePct ?? null;
  const up = (changePct ?? 0) >= 0;
  const oiUsd =
    num(ticker?.openInterest) != null && mark != null
      ? (num(ticker?.openInterest) as number) * mark
      : null;
  const fundingPct =
    num(ticker?.fundingRate) != null ? (num(ticker?.fundingRate) as number) * 100 : null;
  const countdown =
    ticker?.nextFundingTime != null
      ? Math.max(0, ticker.nextFundingTime - now)
      : null;
  const countdownStr =
    countdown != null
      ? (() => {
          const s = Math.floor(countdown / 1000);
          const h = Math.floor(s / 3600);
          const m = Math.floor((s % 3600) / 60);
          const ss = s % 60;
          return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
        })()
      : null;

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
      {/* ── Header stat row ── */}
      <div className="flex flex-wrap items-center gap-x-7 gap-y-3 border-b border-line bg-surface-2/40 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          {selected ? <AssetLogo symbol={selected.symbol} size={28} /> : null}
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <div className="relative inline-flex items-center">
                <select
                  value={assetId}
                  onChange={(e) => {
                    setAssetId(e.target.value);
                    setSetupError(null);
                  }}
                  className="cursor-pointer appearance-none bg-transparent pr-5 text-[16px] font-semibold text-fg outline-none"
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
                  {isPerp ? "perp" : "spot"}
                </span>
              ) : null}
            </div>
            <span className="text-[10px] text-fg-dim">{selected?.name}</span>
          </div>
        </div>

        <Stat label="Mark" value={fmt(mark, digits)} big />
        {isPerp ? <Stat label="Oracle" value={fmt(oracle, digits)} /> : null}
        <Stat
          label="24h Change"
          value={
            changeAbs != null
              ? `${changeAbs >= 0 ? "+" : ""}${fmt(changeAbs, digits)} / ${changePct != null ? `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%` : "—"}`
              : "—"
          }
          tone={changePct == null ? "default" : up ? "positive" : "negative"}
        />
        <Stat label="24h Volume" value={fmtUsd(num(ticker?.quoteVolume))} />
        {isPerp ? (
          <>
            <Stat label="Open Interest" value={fmtUsd(oiUsd)} />
            <Stat
              label="Funding / Countdown"
              value={
                fundingPct != null
                  ? `${fundingPct >= 0 ? "+" : ""}${fundingPct.toFixed(4)}%${countdownStr ? ` · ${countdownStr}` : ""}`
                  : "—"
              }
              tone={fundingPct == null ? "default" : fundingPct >= 0 ? "positive" : "negative"}
            />
          </>
        ) : (
          <>
            <Stat label="24h High" value={fmt(num(ticker?.highPx), digits)} />
            <Stat label="24h Low" value={fmt(num(ticker?.lowPx), digits)} />
          </>
        )}

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
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_240px] xl:grid-cols-[minmax(0,1fr)_240px_288px]">
        <div className="border-line px-3 py-2 lg:border-r">
          {sodexSymbol ? (
            <PriceChart
              symbol={sodexSymbol}
              label={`${selected?.symbol ?? ""} · ${isPerp ? "perp" : "spot"} · SoDEX`}
              market={market}
              levels={levels}
            />
          ) : (
            <div className="flex h-[420px] items-center justify-center text-sm text-fg-dim">
              No SoDEX market for this asset.
            </div>
          )}
        </div>

        <div className="border-t border-line lg:border-t-0">
          <OrderBook
            bids={bids}
            asks={asks}
            markPrice={mark}
            loading={mktLoading}
            symbol={selected?.symbol ?? ""}
            digits={digits}
          />
        </div>

        <div className="border-t border-line xl:border-l xl:border-t-0">
          {selected && sodexSymbol ? (
            <OrderPanel
              symbol={selected.symbol}
              sodexSymbol={sodexSymbol}
              market={selected.market}
              markPrice={mark}
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

      {/* ── Bottom: positions / balances tabs ── */}
      <div className="border-t border-line">
        <div className="flex items-center gap-5 border-b border-line px-4 py-2 text-[12px]">
          {BOTTOM_TABS.map((t) => (
            <button
              key={t}
              onClick={() => setBottomTab(t)}
              className={cn(
                "transition-colors",
                bottomTab === t ? "font-medium text-fg" : "text-fg-dim hover:text-fg-muted",
              )}
            >
              {t} {t === "Positions" ? "0" : ""}
            </button>
          ))}
        </div>
        <div className="px-4 py-6 text-center text-[12px] text-fg-dim">
          Connect a SoDEX wallet to view your {bottomTab.toLowerCase()}.
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "default",
  big = false,
}: {
  label: string;
  value: string;
  tone?: "default" | "positive" | "negative";
  big?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[9.5px] uppercase tracking-wide text-fg-dim">{label}</span>
      <span
        className={cn(
          "font-[var(--font-jetbrains-mono)] leading-tight",
          big ? "text-[15px]" : "text-[12.5px]",
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
