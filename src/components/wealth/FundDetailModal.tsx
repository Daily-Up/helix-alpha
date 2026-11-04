"use client";

/**
 * FundDetailModal — price history chart + full metrics for one Wealth fund.
 * Portaled to <body> with a solid background so it clears any page layering.
 * Read-only: Invest/Subscribe link out to SoDEX.
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/ui/cn";
import { fmtPct, fmtUsd } from "@/lib/format";
import type { WealthFundView, WealthHistoryPoint } from "@/lib/wealth/types";

const RANGES: Array<{ key: string; label: string }> = [
  { key: "1M", label: "1M" },
  { key: "3M", label: "3M" },
  { key: "1Y", label: "1Y" },
];

const sign = (n: number | null) =>
  n == null ? "text-fg-dim" : n >= 0 ? "text-positive" : "text-negative";

export function FundDetailModal({
  fund,
  onClose,
}: {
  fund: WealthFundView;
  onClose: () => void;
}) {
  const [range, setRange] = useState("1Y");
  const [points, setPoints] = useState<WealthHistoryPoint[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/wealth/fund/${encodeURIComponent(fund.fundId)}/history?interval=1d&range=${range}`)
      .then((r) => r.json())
      .then((j) => !cancelled && setPoints(j.ok ? (j.points as WealthHistoryPoint[]) : []))
      .catch(() => !cancelled && setPoints([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [fund.fundId, range]);

  const rangeReturn = useMemo(() => {
    if (!points || points.length < 2) return null;
    const a = points[0].close;
    const b = points[points.length - 1].close;
    return a > 0 ? ((b - a) / a) * 100 : null;
  }, [points]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(2px)" }}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-[640px] rounded-xl border border-line p-5 shadow-2xl"
        style={{ background: "#12161c" }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-3 top-3 text-fg-dim hover:text-fg"
          aria-label="Close"
        >
          ✕
        </button>

        <div className="flex items-start justify-between gap-3 pr-6">
          <div>
            <h3 className="text-[17px] font-semibold text-fg">{fund.displayName}</h3>
            <div className="font-[var(--font-jetbrains-mono)] text-[11px] text-fg-dim">
              {fund.symbol} · {fund.shareCoin}
              {fund.marketStatus ? ` · ${fund.marketStatus}` : ""}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[9.5px] uppercase tracking-wider text-fg-dim">
              {fund.headlineLabel}
            </div>
            <div
              className={cn(
                "font-[var(--font-jetbrains-mono)] text-[18px] font-semibold tabular-nums",
                sign(fund.headlineValue),
              )}
            >
              {fund.headlineValue == null ? "—" : fmtPct(fund.headlineValue)}
            </div>
          </div>
        </div>

        {fund.blurb && (
          <p className="mt-2 text-[12px] leading-snug text-fg-muted">{fund.blurb}</p>
        )}

        {/* Range toggle */}
        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-1">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={cn(
                  "rounded px-2 py-0.5 text-[11px] transition-colors",
                  range === r.key
                    ? "bg-surface-2 font-medium text-fg"
                    : "text-fg-dim hover:text-fg-muted",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          {rangeReturn != null && (
            <span
              className={cn(
                "font-[var(--font-jetbrains-mono)] text-[12px] tabular-nums",
                sign(rangeReturn),
              )}
            >
              {fmtPct(rangeReturn)} over {range}
            </span>
          )}
        </div>

        {/* Chart */}
        <div className="mt-2 h-[180px] rounded-lg border border-line bg-surface p-2">
          {loading ? (
            <div className="flex h-full items-center justify-center text-[12px] text-fg-dim">
              Loading…
            </div>
          ) : points && points.length >= 2 ? (
            <LineChart points={points} />
          ) : (
            <div className="flex h-full items-center justify-center text-[12px] text-fg-dim">
              No price history available.
            </div>
          )}
        </div>

        {/* Metrics */}
        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
          <Metric label="Price" value={fund.price != null ? fmtUsd(fund.price) : "—"} />
          <Metric label="24h" value={fund.changePct != null ? fmtPct(fund.changePct) : "—"} tone={fund.changePct} />
          <Metric label="1-Month" value={fund.roi1M != null ? fmtPct(fund.roi1M) : "—"} tone={fund.roi1M} />
          <Metric label="YTD" value={fund.roiYtd != null ? fmtPct(fund.roiYtd) : "—"} tone={fund.roiYtd} />
          <Metric label="1-Year" value={fund.roi1Y != null ? fmtPct(fund.roi1Y) : "—"} tone={fund.roi1Y} />
          <Metric label="Since Inception" value={fund.roiInception != null ? fmtPct(fund.roiInception) : "—"} tone={fund.roiInception} />
          {fund.isYield && fund.apy7d != null && <Metric label="7D APY" value={fmtPct(fund.apy7d)} tone={fund.apy7d} />}
          {fund.dividendYield != null && <Metric label="Dividend Yield" value={fmtPct(fund.dividendYield)} />}
          {fund.nav != null && <Metric label="NAV" value={fmtUsd(fund.nav)} />}
          {fund.aum != null && <Metric label="AUM" value={fmtUsd(fund.aum)} />}
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-line pt-3">
          <span className="text-[10px] text-fg-dim">
            Data: SoDEX Wealth{fund.asOf ? ` · as of ${fund.asOf.replace("T", " ").slice(0, 16)}Z` : ""}
          </span>
          <a
            href={fund.investUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-accent/50 bg-accent/15 px-4 py-2 text-[12px] font-medium text-accent-2 transition-colors hover:bg-accent/25"
          >
            Invest on SoDEX ↗
          </a>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: number | null;
}) {
  return (
    <div>
      <div className="text-[9.5px] uppercase tracking-wider text-fg-dim">{label}</div>
      <div
        className={cn(
          "font-[var(--font-jetbrains-mono)] text-[13px] tabular-nums",
          tone === undefined ? "text-fg" : sign(tone ?? null),
        )}
      >
        {value}
      </div>
    </div>
  );
}

/** Minimal dependency-free line chart of close prices. */
function LineChart({ points }: { points: WealthHistoryPoint[] }) {
  const W = 600;
  const H = 160;
  const PAD = 6;
  const closes = points.map((p) => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const up = closes[closes.length - 1] >= closes[0];
  const color = up ? "var(--positive)" : "var(--negative)";

  const coords = points.map((p, i) => {
    const x = PAD + (i / (points.length - 1)) * (W - 2 * PAD);
    const y = PAD + (1 - (p.close - min) / span) * (H - 2 * PAD);
    return [x, y] as const;
  });
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area =
    `M${coords[0][0].toFixed(1)},${(H - PAD).toFixed(1)} ` +
    coords.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(" ") +
    ` L${coords[coords.length - 1][0].toFixed(1)},${(H - PAD).toFixed(1)} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="wealth-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#wealth-area)" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
