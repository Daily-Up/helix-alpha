"use client";

/**
 * Sparkline — a lightweight SVG area/line chart from SoDEX klines, with an
 * optional dashed vertical marker at the event time. Used faded as a hero-card
 * background and solid in the detail panel. No photos, no third-party images —
 * the price itself is the art.
 */

import { useId } from "react";
import type { SodexCandle } from "@/lib/sodex/types";

const UP = "#0ecb81";
const DOWN = "#f6465d";

export function Sparkline({
  candles,
  eventMs,
  up,
  faded,
  className,
  strokeWidth = 1.5,
}: {
  candles: SodexCandle[];
  eventMs?: number;
  /** Colour override; otherwise derived from first vs last close. */
  up?: boolean;
  /** Background mode — softer stroke + fill. */
  faded?: boolean;
  className?: string;
  strokeWidth?: number;
}) {
  const gid = useId();
  const closes = candles.map((c) => Number(c.close)).filter(Number.isFinite);
  if (closes.length < 2) return null;

  const W = 300;
  const H = 100;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const nPts = closes.length;
  const xAt = (i: number) => (i / (nPts - 1)) * W;
  const yAt = (v: number) => H - ((v - min) / range) * (H * 0.88) - H * 0.06;

  const pts = closes.map((v, i) => `${xAt(i).toFixed(2)},${yAt(v).toFixed(2)}`);
  const line = `M${pts.join("L")}`;
  const area = `${line}L${W.toFixed(2)},${H}L0,${H}Z`;
  const rising = up ?? closes[nPts - 1] >= closes[0];
  const color = rising ? UP : DOWN;

  let markerX: number | null = null;
  if (eventMs != null && candles.length > 1) {
    const t0 = candles[0].openTime;
    const t1 = candles[nPts - 1].openTime;
    if (t1 > t0 && eventMs >= t0 && eventMs <= t1)
      markerX = ((eventMs - t0) / (t1 - t0)) * W;
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden
      style={{ display: "block" }}
    >
      <defs>
        <linearGradient id={`spk-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={faded ? 0.2 : 0.26} />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spk-${gid})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeOpacity={faded ? 0.5 : 0.9}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {markerX != null ? (
        <line
          x1={markerX}
          y1="0"
          x2={markerX}
          y2={H}
          stroke="#e6e8eb"
          strokeOpacity="0.35"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}
