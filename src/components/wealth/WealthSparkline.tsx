"use client";

/**
 * WealthSparkline — a tiny 1-month price line for a fund card, fetched lazily
 * from /api/wealth/fund/{id}/history. Renders nothing until it has ≥2 points
 * (no axes, no fabricated data). Colour follows the net 1M direction.
 */

import { useEffect, useRef, useState } from "react";
import type { WealthHistoryPoint } from "@/lib/wealth/types";

export function WealthSparkline({ fundId }: { fundId: string }) {
  const [points, setPoints] = useState<WealthHistoryPoint[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);

  // Only fetch once the card is near the viewport (keeps 11 cards light).
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  useEffect(() => {
    if (!seen) return;
    let cancelled = false;
    fetch(`/api/wealth/fund/${encodeURIComponent(fundId)}/history?interval=1d&range=1M`)
      .then((r) => r.json())
      .then((j) => !cancelled && setPoints(j.ok ? (j.points as WealthHistoryPoint[]) : []))
      .catch(() => !cancelled && setPoints([]));
    return () => {
      cancelled = true;
    };
  }, [seen, fundId]);

  return (
    <div ref={ref} className="h-6 w-full">
      {points && points.length >= 2 ? <Line points={points} /> : null}
    </div>
  );
}

function Line({ points }: { points: WealthHistoryPoint[] }) {
  const W = 120;
  const H = 24;
  const closes = points.map((p) => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const up = closes[closes.length - 1] >= closes[0];
  const color = up ? "var(--positive)" : "var(--negative)";
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * W;
      const y = 2 + (1 - (p.close - min) / span) * (H - 4);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="none">
      <path d={d} fill="none" stroke={color} strokeWidth="1.25" vectorEffect="non-scaling-stroke" opacity="0.85" />
    </svg>
  );
}
