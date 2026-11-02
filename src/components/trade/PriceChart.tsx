"use client";

/**
 * PriceChart — TradingView-grade candlestick + volume chart for the Trade
 * Terminal, fed by live SoDEX klines. OHLC legend tracks the crosshair,
 * volume sits in the lower band, and Setup levels draw as price lines.
 * lightweight-charts is imported inside the effect so it never SSRs.
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
  volume: number;
}

const UP = "#26a69a";
const DOWN = "#ef5350";

const fmt = (n: number | null, d = 2) =>
  n == null
    ? "—"
    : n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

export function PriceChart({
  symbol,
  label,
  market,
  levels,
}: {
  symbol: string;
  /** Display label e.g. "GOOGL · 1h". */
  label: string;
  market: "spot" | "perp";
  levels?: SetupLevel[];
}) {
  const [interval, setIntervalSel] = useState<Interval>("1h");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [legend, setLegend] = useState<Candle | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candleRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const volRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priceLinesRef = useRef<any[]>([]);
  const candlesRef = useRef<Candle[]>([]);

  const digits = (candles[candles.length - 1]?.close ?? 1) < 10 ? 4 : 2;

  // Fetch candles.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetch(
      `/api/sodex/candles?symbol=${encodeURIComponent(symbol)}&market=${market}&interval=${interval}&limit=300`,
    )
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (!j.ok) throw new Error(j.error ?? "candles failed");
        setCandles(j.candles as Candle[]);
      })
      .catch((e) => !cancelled && setErr((e as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [symbol, market, interval]);

  // Create chart once.
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
          textColor: "rgba(190,190,195,0.55)",
          fontSize: 11,
          fontFamily: "var(--font-jetbrains-mono), monospace",
        },
        grid: {
          vertLines: { color: "rgba(255,255,255,0.03)" },
          horzLines: { color: "rgba(255,255,255,0.03)" },
        },
        rightPriceScale: {
          borderColor: "rgba(255,255,255,0.06)",
          scaleMargins: { top: 0.08, bottom: 0.26 },
        },
        timeScale: {
          borderColor: "rgba(255,255,255,0.06)",
          timeVisible: true,
          secondsVisible: false,
        },
        crosshair: {
          mode: LWC.CrosshairMode.Normal,
          vertLine: { color: "rgba(255,255,255,0.2)", labelBackgroundColor: "#2a2a2e" },
          horzLine: { color: "rgba(255,255,255,0.2)", labelBackgroundColor: "#2a2a2e" },
        },
        autoSize: true,
      });
      const candle = chart.addCandlestickSeries({
        upColor: UP,
        downColor: DOWN,
        borderUpColor: UP,
        borderDownColor: DOWN,
        wickUpColor: UP,
        wickDownColor: DOWN,
      });
      const vol = chart.addHistogramSeries({
        priceFormat: { type: "volume" },
        priceScaleId: "vol",
        // Hide the volume series' own last-value badge + price line so it
        // doesn't clash with the price axis (the stray "49.94" label).
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale("vol").applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
      });
      chartRef.current = chart;
      candleRef.current = candle;
      volRef.current = vol;

      chart.subscribeCrosshairMove((param: { time?: unknown }) => {
        const data = candlesRef.current;
        if (!param.time) {
          setLegend(data[data.length - 1] ?? null);
          return;
        }
        const hit = data.find((c) => c.time === param.time);
        if (hit) setLegend(hit);
      });

      setReady(true);
    })();
    return () => {
      disposed = true;
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
        candleRef.current = null;
        volRef.current = null;
      }
    };
  }, []);

  // Push data.
  useEffect(() => {
    candlesRef.current = candles;
    if (!ready || !candleRef.current || candles.length === 0) return;
    candleRef.current.setData(
      candles.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    volRef.current?.setData(
      candles.map((c) => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? "rgba(38,166,154,0.35)" : "rgba(239,83,80,0.35)",
      })),
    );
    chartRef.current?.timeScale().fitContent();
    setLegend(candles[candles.length - 1] ?? null);
  }, [candles, ready]);

  // Setup levels → price lines.
  useEffect(() => {
    const series = candleRef.current;
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
      priceLinesRef.current.push(
        series.createPriceLine({
          price: lv.price,
          color: lv.kind === "support" ? UP : DOWN,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: lv.label.slice(0, 20),
        }),
      );
    }
  }, [levels, ready, candles]);

  const up = legend ? legend.close >= legend.open : true;
  const chg = legend ? legend.close - legend.open : 0;
  const chgPct = legend && legend.open ? (chg / legend.open) * 100 : 0;

  return (
    <div className="flex h-full flex-col">
      {/* Timeframe controls */}
      <div className="flex shrink-0 items-center gap-0.5 border-b border-line px-1 pb-2">
        {INTERVALS.map((iv) => (
          <button
            key={iv}
            onClick={() => setIntervalSel(iv)}
            className={cn(
              "rounded px-2 py-1 text-[11px] font-medium transition-colors",
              iv === interval
                ? "bg-surface-2 text-fg"
                : "text-fg-dim hover:text-fg-muted",
            )}
          >
            {iv}
          </button>
        ))}
        <span className="ml-2 text-[10px] text-fg-dim">
          {loading ? "loading…" : ""}
        </span>
      </div>

      {/* Chart with OHLC legend overlay — fills the remaining cell height;
          lightweight-charts autoSize (ResizeObserver) tracks the container. */}
      <div className="relative min-h-0 flex-1 pt-2">
        <div className="pointer-events-none absolute left-2 top-2 z-10 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-[var(--font-jetbrains-mono)] text-[11px]">
          <span className="text-fg-muted">{label}</span>
          {legend ? (
            <>
              <span className="text-fg-dim">O</span>
              <span className={up ? "text-positive" : "text-negative"}>{fmt(legend.open, digits)}</span>
              <span className="text-fg-dim">H</span>
              <span className={up ? "text-positive" : "text-negative"}>{fmt(legend.high, digits)}</span>
              <span className="text-fg-dim">L</span>
              <span className={up ? "text-positive" : "text-negative"}>{fmt(legend.low, digits)}</span>
              <span className="text-fg-dim">C</span>
              <span className={up ? "text-positive" : "text-negative"}>{fmt(legend.close, digits)}</span>
              <span className={up ? "text-positive" : "text-negative"}>
                {chg >= 0 ? "+" : ""}
                {fmt(chg, digits)} ({chgPct >= 0 ? "+" : ""}
                {chgPct.toFixed(2)}%)
              </span>
            </>
          ) : null}
        </div>
        <div ref={containerRef} className="h-full w-full" />
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
