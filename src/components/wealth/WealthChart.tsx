"use client";

/**
 * WealthChart — the fund page's price/NAV line with event markers. Markers are
 * placed at the timestamps of the fund's linked Helix events (coloured by
 * sentiment); hovering a marker shows the headline. Dependency-free SVG.
 */

import { useMemo, useState } from "react";
import { cn } from "@/components/ui/cn";
import { fmtUsd } from "@/lib/format";
import type { WealthHistoryPoint } from "@/lib/wealth/types";
import type { FundEvent } from "@/lib/wealth/suggestions";

const SENT_COLOR: Record<string, string> = {
  positive: "var(--positive)",
  negative: "var(--negative)",
  neutral: "var(--fg-dim)",
};

export function WealthChart({
  points,
  events = [],
}: {
  points: WealthHistoryPoint[];
  events?: FundEvent[];
}) {
  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);
  const W = 800;
  const H = 240;
  const PADX = 8;
  const PADY = 14;

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const ts = points.map((p) => Date.parse(p.ts));
    const closes = points.map((p) => p.close);
    const tMin = ts[0];
    const tMax = ts[ts.length - 1];
    const tSpan = tMax - tMin || 1;
    const lo = Math.min(...closes);
    const hi = Math.max(...closes);
    const vSpan = hi - lo || 1;
    const xOf = (t: number) => PADX + ((t - tMin) / tSpan) * (W - 2 * PADX);
    const yOf = (v: number) => PADY + (1 - (v - lo) / vSpan) * (H - 2 * PADY);
    const coords = points.map((p, i) => [xOf(ts[i]), yOf(p.close)] as const);
    const up = closes[closes.length - 1] >= closes[0];
    return { tMin, tMax, lo, hi, xOf, yOf, coords, up };
  }, [points]);

  if (!geom) {
    return (
      <div className="flex h-[240px] items-center justify-center text-[12px] text-fg-dim">
        No price history available.
      </div>
    );
  }

  const color = geom.up ? "var(--positive)" : "var(--negative)";
  const path = geom.coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area =
    `M${geom.coords[0][0].toFixed(1)},${(H - PADY).toFixed(1)} ` +
    geom.coords.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(" ") +
    ` L${geom.coords[geom.coords.length - 1][0].toFixed(1)},${(H - PADY).toFixed(1)} Z`;

  // Event markers within the chart time window.
  const markers = events
    .map((e) => ({ e, t: Date.parse(e.ts) }))
    .filter((m) => Number.isFinite(m.t) && m.t >= geom.tMin && m.t <= geom.tMax)
    .map((m) => ({ ...m, x: geom.xOf(m.t) }));

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-[240px] w-full"
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="wc-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.16" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#wc-area)" />
        <path d={path} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {/* event markers */}
        {markers.map((m, i) => (
          <g key={i}>
            <line
              x1={m.x}
              x2={m.x}
              y1={PADY}
              y2={H - PADY}
              stroke={SENT_COLOR[m.e.sentiment] ?? "var(--fg-dim)"}
              strokeWidth="1"
              strokeDasharray="2 2"
              opacity="0.35"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={m.x}
              cy={PADY}
              r="3.5"
              fill={SENT_COLOR[m.e.sentiment] ?? "var(--fg-dim)"}
              className="cursor-pointer"
              onMouseEnter={() =>
                setHover({ x: m.x, y: PADY, label: `${new Date(m.t).toISOString().slice(0, 10)} · ${m.e.title}` })
              }
            />
          </g>
        ))}
      </svg>
      {/* y-axis min/max */}
      <div className="pointer-events-none absolute right-1 top-1 font-[var(--font-jetbrains-mono)] text-[9px] text-fg-dim">
        {fmtUsd(geom.hi)}
      </div>
      <div className="pointer-events-none absolute bottom-4 right-1 font-[var(--font-jetbrains-mono)] text-[9px] text-fg-dim">
        {fmtUsd(geom.lo)}
      </div>
      {hover && (
        <div
          className={cn(
            "pointer-events-none absolute z-10 max-w-[280px] rounded-md border border-line bg-surface-2 px-2 py-1 text-[10.5px] leading-snug text-fg shadow-lg",
          )}
          style={{ left: `${(hover.x / W) * 100}%`, top: 2, transform: "translateX(-50%)" }}
        >
          {hover.label}
        </div>
      )}
    </div>
  );
}
