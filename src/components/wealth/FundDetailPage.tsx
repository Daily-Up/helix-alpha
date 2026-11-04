"use client";

/**
 * FundDetailPage — /wealth/[fundId]. Read-only in v1: header, price chart with
 * event markers, key stats + my holding, a News tab (SoDEX per-fund news +
 * mapped Helix events), an About tab, and an Invest panel that links out to
 * SoDEX. All data from /api/wealth/fund/[id] + /history. No invented numbers.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { fmtPct, fmtUsd, fmtRelative } from "@/lib/format";
import { useSodexAuth } from "@/components/sodex/auth/SodexAuthProvider";
import { WealthInvestPanel } from "./WealthInvestPanel";
import { wealthInvestEnabled } from "@/lib/wealth/spot-order";
import { CATEGORY_LABEL, type WealthFundView, type WealthPosition, type WealthHistoryPoint } from "@/lib/wealth/types";
import type { FundPageMeta } from "@/lib/wealth/catalog";
import type { WealthNewsItem } from "@/lib/wealth/client";
import type { FundEvent } from "@/lib/wealth/suggestions";
import { WealthChart } from "./WealthChart";

interface FundResp {
  ok: boolean;
  fund: WealthFundView;
  meta: FundPageMeta;
  holding: WealthPosition | null;
  news: WealthNewsItem[];
  events: FundEvent[];
}

const RANGES = [
  { key: "1W", label: "1W" },
  { key: "1M", label: "1M" },
  { key: "1Y", label: "1Y" },
  { key: "ALL", label: "All" },
];
const sign = (n: number | null) => (n == null ? "text-fg-dim" : n >= 0 ? "text-positive" : "text-negative");

export function FundDetailPage({ fundId }: { fundId: string }) {
  const auth = useSodexAuth();
  const address = auth.address;
  const [data, setData] = useState<FundResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [range, setRange] = useState("1Y");
  const [points, setPoints] = useState<WealthHistoryPoint[] | null>(null);
  const [tab, setTab] = useState<"news" | "about">("news");
  const [investTab, setInvestTab] = useState<"buy" | "sell">("buy");

  // A "Sell" shortcut elsewhere can deep-link with ?action=sell.
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get("action") === "sell") {
        setInvestTab("sell");
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const q = address ? `?address=${address}` : "";
    fetch(`/api/wealth/fund/${encodeURIComponent(fundId)}${q}`)
      .then((r) => (r.status === 404 ? { ok: false, notFound: true } : r.json()))
      .then((j: FundResp & { notFound?: boolean }) => {
        if (cancelled) return;
        if (j.notFound) setNotFound(true);
        else setData(j.ok ? j : null);
      })
      .catch(() => !cancelled && setData(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [fundId, address]);

  // Quiet refetch after a fill — updates holding/price without a loading flash.
  const refetch = useCallback(() => {
    const q = address ? `?address=${address}` : "";
    fetch(`/api/wealth/fund/${encodeURIComponent(fundId)}${q}`)
      .then((r) => r.json())
      .then((j: FundResp) => j.ok && setData(j))
      .catch(() => {});
  }, [fundId, address]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/wealth/fund/${encodeURIComponent(fundId)}/history?interval=1d&range=${range}`)
      .then((r) => r.json())
      .then((j) => !cancelled && setPoints(j.ok ? (j.points as WealthHistoryPoint[]) : []))
      .catch(() => !cancelled && setPoints([]));
    return () => {
      cancelled = true;
    };
  }, [fundId, range]);

  // Merge Helix events + SoDEX news into one feed, newest first.
  const feed = useMemo(() => {
    if (!data) return [];
    const helix = data.events.map((e) => ({
      key: `h-${e.id}`,
      title: e.title,
      sentiment: e.sentiment === "positive" ? "Bullish" : e.sentiment === "negative" ? "Bearish" : "Neutral",
      ts: e.ts,
      href: e.href,
      source: `Helix event · ${e.severity} · conf ${(e.confidence * 100).toFixed(0)}%`,
    }));
    const news = data.news
      .filter((n) => n.ts)
      .map((n) => ({
        key: `n-${n.id}`,
        title: n.title,
        sentiment: n.sentiment ?? "—",
        ts: n.ts as string,
        href: n.url,
        source: n.source ? `SoDEX news · ${n.source}` : "SoDEX news",
      }));
    return [...helix, ...news].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 40);
  }, [data]);

  if (loading) {
    return <div className="rounded-lg border border-line bg-surface px-6 py-16 text-center text-[13px] text-fg-dim">Loading fund…</div>;
  }
  if (notFound || !data) {
    return (
      <div className="rounded-lg border border-line bg-surface px-6 py-16 text-center">
        <p className="text-[14px] text-fg">Fund not found.</p>
        <Link href="/wealth-index" className="mt-3 inline-block text-[12px] text-accent-2 hover:underline">
          ← Back to Wealth Index
        </Link>
      </div>
    );
  }

  const { fund, meta, holding } = data;
  const open = fund.marketStatus === "TRADING";

  return (
    <div className="flex flex-col gap-5">
      <Link href="/wealth-index" className="text-[12px] text-accent-2 hover:underline">
        ← Wealth Index
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[24px] font-light text-fg">{fund.displayName}</h1>
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
              {CATEGORY_LABEL[fund.category]}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-[var(--font-jetbrains-mono)] text-[11px] text-fg-dim">
            <span>{fund.symbol} · {fund.shareCoin}</span>
            <span className={cn("flex items-center gap-1", open ? "text-positive" : "text-fg-dim")}>
              <span className={cn("h-1.5 w-1.5 rounded-full", open ? "bg-positive" : "bg-fg-dim")} />
              {fund.marketStatus === "TRADING" ? "Open" : fund.marketStatus === "CLOSED" ? "Closed" : fund.marketStatus ?? "—"} · {meta.hours}
            </span>
            <span>Min {fmtUsd(meta.minSubUsd)}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[9.5px] uppercase tracking-wider text-fg-dim">{fund.headlineLabel}</div>
          <div className={cn("font-[var(--font-jetbrains-mono)] text-[22px] font-semibold tabular-nums", sign(fund.headlineValue))}>
            {fund.headlineValue == null ? "—" : fmtPct(fund.headlineValue)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* Left: chart + stats + tabs */}
        <div className="flex flex-col gap-4">
          {/* Chart */}
          <div className="rounded-lg border border-line bg-surface p-3">
            <div className="mb-1 flex items-center justify-between">
              <div className="flex items-center gap-1">
                {RANGES.map((r) => (
                  <button
                    key={r.key}
                    onClick={() => setRange(r.key)}
                    className={cn(
                      "rounded px-2 py-0.5 text-[11px] transition-colors",
                      range === r.key ? "bg-surface-2 font-medium text-fg" : "text-fg-dim hover:text-fg-muted",
                    )}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              {data.events.length > 0 && (
                <span className="text-[10px] text-fg-dim">● markers = linked Helix events</span>
              )}
            </div>
            {points == null ? (
              <div className="flex h-[240px] items-center justify-center text-[12px] text-fg-dim">Loading…</div>
            ) : (
              <WealthChart points={points} events={data.events} />
            )}
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-4">
            <Stat label="24h" value={fund.changePct != null ? fmtPct(fund.changePct) : "—"} tone={fund.changePct} />
            <Stat label="1-Month" value={fund.roi1M != null ? fmtPct(fund.roi1M) : "—"} tone={fund.roi1M} />
            {fund.isYield ? (
              <Stat label="7D APY" value={fund.apy7d != null ? fmtPct(fund.apy7d) : "—"} tone={fund.apy7d} />
            ) : (
              <Stat
                label={fund.roi1Y != null ? "1-Year" : "Since Inception"}
                value={fund.roi1Y != null ? fmtPct(fund.roi1Y) : fund.roiInception != null ? fmtPct(fund.roiInception) : "—"}
                tone={fund.roi1Y ?? fund.roiInception}
              />
            )}
            <Stat label="Price" value={fund.price != null ? fmtUsd(fund.price) : "—"} />
          </div>

          {/* My holding */}
          {holding && (holding.marketValue ?? 0) > 0.0001 && (
            <div className="rounded-lg border border-line bg-surface p-4">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wider text-fg-dim">My holding</div>
                {fund.spotSymbol && wealthInvestEnabled() && (
                  <button
                    onClick={() => {
                      setInvestTab("sell");
                      document.getElementById("invest-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
                    }}
                    className="rounded border border-negative/50 px-2.5 py-1 text-[11px] font-medium text-negative transition-colors hover:bg-negative/10"
                  >
                    Sell
                  </button>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-end gap-x-8 gap-y-2">
                <Stat label="Value" value={fmtUsd(holding.marketValue)} />
                <Stat label="Units" value={holding.shares != null ? holding.shares.toFixed(4) : "—"} />
                <Stat label="Unrealised" value={holding.unrealizedPnl != null ? signedUsd(holding.unrealizedPnl) : "—"} tone={holding.unrealizedPnl} />
                <Stat label="24h" value={holding.pnl24h != null ? signedUsd(holding.pnl24h) : "—"} tone={holding.pnl24h} />
              </div>
            </div>
          )}

          {/* Tabs */}
          <div className="rounded-lg border border-line bg-surface">
            <div className="flex items-center gap-4 border-b border-line px-4 py-2.5 text-[12px]">
              <TabBtn active={tab === "news"} onClick={() => setTab("news")}>
                News & events
              </TabBtn>
              <TabBtn active={tab === "about"} onClick={() => setTab("about")}>
                About
              </TabBtn>
            </div>
            {tab === "news" ? (
              <div className="divide-y divide-line">
                {feed.length === 0 ? (
                  <div className="px-4 py-6 text-[12px] text-fg-dim">No recent news or mapped events.</div>
                ) : (
                  feed.map((f) => (
                    <div key={f.key} className="flex items-start gap-3 px-4 py-2.5">
                      <SentChip s={f.sentiment} />
                      <div className="min-w-0 flex-1">
                        {f.href ? (
                          <a
                            href={f.href}
                            target={f.href.startsWith("/") ? undefined : "_blank"}
                            rel="noopener noreferrer"
                            className="text-[12.5px] leading-snug text-fg hover:text-accent-2"
                          >
                            {f.title}
                          </a>
                        ) : (
                          <span className="text-[12.5px] leading-snug text-fg">{f.title}</span>
                        )}
                        <div className="mt-0.5 text-[10px] text-fg-dim">
                          {f.source} · {fmtRelative(Date.parse(f.ts))}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-3 px-4 py-4 text-[12.5px]">
                {fund.blurb && <p className="text-fg-muted">{fund.blurb}</p>}
                <AboutRow label="Underlying" value={meta.underlying} />
                <AboutRow label="Type" value={CATEGORY_LABEL[fund.category]} />
                <AboutRow label="Hours" value={meta.hours} />
                <AboutRow label="Min subscription" value={fmtUsd(meta.minSubUsd)} />
                <AboutRow label="Redemption" value={meta.redemption} />
                <AboutRow label="Fees" value="SoDEX exchange fees apply; Helix adds no fee in read-only mode." />
                {fund.aum != null && <AboutRow label="AUM" value={fmtUsd(fund.aum)} />}
                {fund.nav != null && <AboutRow label="NAV / share" value={fund.nav.toFixed(4)} />}
              </div>
            )}
          </div>
        </div>

        {/* Right: invest panel — in-app Buy/Sell for spot-tradable funds when
            the beta flag is on, otherwise link out to SoDEX. */}
        <div id="invest-panel" className="h-fit lg:sticky lg:top-4">
          {fund.spotSymbol && wealthInvestEnabled() ? (
            <WealthInvestPanel
              fund={fund}
              holding={holding}
              onFilled={refetch}
              tab={investTab}
              onTab={setInvestTab}
            />
          ) : (
            <div className="rounded-lg border border-line bg-surface p-4">
              <div className="text-[10px] uppercase tracking-wider text-fg-dim">Invest</div>
              <div className="mt-2 flex items-baseline justify-between">
                <span className="text-[11px] text-fg-muted">{fund.headlineLabel}</span>
                <span className={cn("font-[var(--font-jetbrains-mono)] text-[16px] font-semibold tabular-nums", sign(fund.headlineValue))}>
                  {fund.headlineValue == null ? "—" : fmtPct(fund.headlineValue)}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[11px] text-fg-dim">
                <span>Min subscription</span>
                <span>{fmtUsd(meta.minSubUsd)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[11px] text-fg-dim">
                <span>Status</span>
                <span className={open ? "text-positive" : "text-fg-dim"}>
                  {fund.marketStatus === "TRADING" ? "Open" : fund.marketStatus === "CLOSED" ? "Closed" : "—"}
                </span>
              </div>
              <a
                href={fund.investUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 block rounded-md border border-accent/50 bg-accent/15 py-2.5 text-center text-[13px] font-medium text-accent-2 transition-colors hover:bg-accent/25"
              >
                Invest on SoDEX ↗
              </a>
              <p className="mt-2 text-center text-[9.5px] text-fg-dim">
                In-app investing is coming to Helix. Not financial advice.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function signedUsd(n: number): string {
  return `${n >= 0 ? "+" : "−"}${fmtUsd(Math.abs(n))}`;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: number | null }) {
  return (
    <div>
      <div className="text-[9.5px] uppercase tracking-wider text-fg-dim">{label}</div>
      <div className={cn("font-[var(--font-jetbrains-mono)] text-[14px] tabular-nums", tone === undefined ? "text-fg" : sign(tone ?? null))}>
        {value}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn("relative transition-colors", active ? "font-medium text-fg" : "text-fg-dim hover:text-fg-muted")}
    >
      {children}
      {active && <span className="absolute inset-x-0 -bottom-[10px] h-[2px] rounded-full bg-accent" />}
    </button>
  );
}

function AboutRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:gap-3">
      <span className="w-32 shrink-0 text-[10px] uppercase tracking-wider text-fg-dim">{label}</span>
      <span className="text-fg-muted">{value}</span>
    </div>
  );
}

function SentChip({ s }: { s: string }) {
  const map: Record<string, string> = {
    Bullish: "bg-positive/15 text-positive",
    Bearish: "bg-negative/15 text-negative",
    Neutral: "bg-surface-2 text-fg-dim",
  };
  return (
    <span className={cn("mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide", map[s] ?? "bg-surface-2 text-fg-dim")}>
      {s === "—" ? "news" : s}
    </span>
  );
}
