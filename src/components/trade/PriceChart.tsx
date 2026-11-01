"use client";

/**
 * PriceChart — candlestick chart for the Trade Terminal, fed by
 * /api/sodex/candles (SoDEX OHLCV). lightweight-charts is imported
 * dynamically inside the effect so it never runs during SSR.
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import type { SetupLevel } from "./SetupCard";

const INTERVALS = ["15m", "1h", "4h", "1d"] as const;
type Interval = (typeof INTERVALS)[number];

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function PriceChart({
  symbol,
  market,
  levels,
}: {
  symbol: string;
  market: "spot" | "perp";
  /** Optional Setup levels to draw as horizontal price lines. */
  levels?: SetupLevel[];
}) {
  const [interval, setIntervalSel] = useState<Interval>("1h");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seriesRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priceLinesRef = useRef<any[]>([]);

  // Fetch candles on symbol / market / interval change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetch(
      `/api/sodex/candles?symbol=${encodeURIComponent(symbol)}&market=${market}&interval=${interval}&limit=200`,
    )
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (!j.ok) throw new Error(j.error ?? "candles failed");
        setCandles(j.candles as Candle[]);
      })
      .catch((e) => {
        if (!cancelled) setErr((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, market, interval]);

  // Create the chart once.
  useEffect(() => {
    let disposed = false;
    (async () => {
      const el = containerRef.current;
      if (!el) return;
      const LWC = await import("lightweight-charts");
      if (disposed || !containerRef.current) return;
      const chart = LWC.createChart(containerRef.current, {
        layout: {
          background: { type: LWC.ColorType.Solid, color: "transparent" },
          textColor: "rgba(200,200,200,0.55)",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: "rgba(255,255,255,0.04)" },
          horzLines: { color: "rgba(255,255,255,0.04)" },
        },
        rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
        timeScale: {
          borderColor: "rgba(255,255,255,0.08)",
          timeVisible: true,
          secondsVisible: false,
        },
        crosshair: { mode: LWC.CrosshairMode.Normal },
        autoSize: true,
      });
      const series = chart.addCandlestickSeries({
        upColor: "#34c39a",
        downColor: "#e5575f",
        borderUpColor: "#34c39a",
        borderDownColor: "#e5575f",
        wickUpColor: "#34c39a",
        wickDownColor: "#e5575f",
      });
      chartRef.current = chart;
      seriesRef.current = series;
      setReady(true);
    })();
    return () => {
      disposed = true;
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
        seriesRef.current = null;
      }
    };
  }, []);

  // Push data once both the chart and candles are available.
  useEffect(() => {
    if (!ready || !seriesRef.current || candles.length === 0) return;
    seriesRef.current.setData(
      candles.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles, ready]);

  // Draw / redraw Setup levels as horizontal price lines.
  useEffect(() => {
    const series = seriesRef.current;
    if (!ready || !series) return;
    for (const pl of priceLinesRef.current) {
      try {
        series.removePriceLine(pl);
      } catch {
        /* no-op */
      }
    }
    priceLinesRef.current = [];
    for (const lv of levels ?? []) {
      const line = series.createPriceLine({
        price: lv.price,
        color: lv.kind === "support" ? "#34c39a" : "#e5575f",
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title: lv.label.slice(0, 22),
      });
      priceLinesRef.current.push(line);
    }
  }, [levels, ready, candles]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        {INTERVALS.map((iv) => (
          <button
            key={iv}
            onClick={() => setIntervalSel(iv)}
            className={cn(
              "rounded border px-2 py-0.5 text-[11px] transition-colors",
              iv === interval
                ? "border-accent/40 bg-accent/15 text-accent-2"
                : "border-line text-fg-muted hover:border-line-2 hover:text-fg",
            )}
          >
            {iv}
          </button>
        ))}
        {loading ? (
          <span className="ml-2 text-[11px] text-fg-dim">loading…</span>
        ) : null}
      </div>
      <div className="relative">
        <div ref={containerRef} className="h-[360px] w-full" />
        {err ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-fg-dim">
            Chart unavailable — {err}
          </div>
        ) : null}
        {!err && !loading && candles.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-fg-dim">
            No candles for this market.
          </div>
        ) : null}
      </div>
    </div>
  );
}
