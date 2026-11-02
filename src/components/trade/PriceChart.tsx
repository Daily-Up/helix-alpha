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
// Volume bars use the terminal palette (green up / red down), semi-opaque.
const VOL_UP = "rgba(14,203,129,0.5)";
const VOL_DOWN = "rgba(246,70,93,0.5)";
const NEUTRAL = "rgba(190,190,195,0.75)";

/** Decimal places implied by a tick size (1 → 0, 0.001 → 3). */
const decimalsFromTick = (tick?: number) => {
  if (!tick || tick <= 0) return 2;
  if (tick >= 1) return 0;
  return Math.min(8, Math.ceil(-Math.log10(tick)));
};

export interface ChartOrderLine {
  price: number;
  side: "buy" | "sell";
  size: string;
}

const fmt = (n: number | null, d = 2) =>
  n == null
    ? "—"
    : n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

export function PriceChart({
  symbol,
  label,
  market,
  levels,
  tickSize,
  positionEntry,
  positionLiq,
  tpPrice,
  slPrice,
  orderLines,
}: {
  symbol: string;
  /** Display label e.g. "GOOGL · 1h". */
  label: string;
  market: "spot" | "perp";
  levels?: SetupLevel[];
  /** Price tick size → axis precision (BTC → "82,000", no ".00"). */
  tickSize?: number;
  /** Open-position entry + liquidation price for this symbol (price lines). */
  positionEntry?: number | null;
  positionLiq?: number | null;
  /** Take-profit / stop-loss trigger prices for this symbol's position. */
  tpPrice?: number | null;
  slPrice?: number | null;
  /** Open orders for this symbol, drawn as side-coloured price lines. */
  orderLines?: ChartOrderLine[];
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tradeLinesRef = useRef<any[]>([]);
  const candlesRef = useRef<Candle[]>([]);
  // Position levels the price scale should always keep in view (entry / TP /
  // SL), so the dashed trigger lines aren't scrolled off the top or bottom.
  const levelsRef = useRef<number[]>([]);

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
        // Localised price axis: thousands separators, precision from tick size
        // (BTC → "82,000", not "82000.00"). Refreshed on tick-size change below.
        localization: {
          priceFormatter: (p: number) =>
            p.toLocaleString(undefined, {
              minimumFractionDigits: decimalsFromTick(tickSize),
              maximumFractionDigits: decimalsFromTick(tickSize),
            }),
        },
        layout: {
          background: { type: LWC.ColorType.Solid, color: "transparent" },
          textColor: "rgba(190,190,195,0.55)",
          fontSize: 11,
          fontFamily: "var(--font-jetbrains-mono), monospace",
          // Attribution shown as a text link in the footer instead (the logo
          // overlapped the volume bars); the license requires the credit.
          attributionLogo: false,
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
        priceFormat: {
          type: "price",
          precision: decimalsFromTick(tickSize),
          minMove: tickSize && tickSize > 0 ? tickSize : 0.01,
        },
        // Keep the position's entry / TP / SL inside the visible range so the
        // dashed trigger lines never scroll off-screen.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        autoscaleInfoProvider: (orig: () => any) => {
          const res = orig();
          const lv = levelsRef.current;
          if (!res || !res.priceRange || lv.length === 0) return res;
          let { minValue, maxValue } = res.priceRange;
          for (const v of lv) {
            if (v < minValue) minValue = v;
            if (v > maxValue) maxValue = v;
          }
          return { ...res, priceRange: { minValue, maxValue } };
        },
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
        color: c.close >= c.open ? VOL_UP : VOL_DOWN,
      })),
    );
    chartRef.current?.timeScale().fitContent();
    setLegend(candles[candles.length - 1] ?? null);
  }, [candles, ready]);

  // Keep the price-axis precision in sync with the symbol's tick size.
  useEffect(() => {
    if (!ready || !candleRef.current) return;
    candleRef.current.applyOptions({
      priceFormat: {
        type: "price",
        precision: decimalsFromTick(tickSize),
        minMove: tickSize && tickSize > 0 ? tickSize : 0.01,
      },
    });
    chartRef.current?.applyOptions({
      localization: {
        priceFormatter: (p: number) =>
          p.toLocaleString(undefined, {
            minimumFractionDigits: decimalsFromTick(tickSize),
            maximumFractionDigits: decimalsFromTick(tickSize),
          }),
      },
    });
  }, [tickSize, ready]);

  // Live updates: poll the latest bars and update() them (sets the volume
  // colour on every incremental update, not just the initial setData).
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const poll = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const r = await fetch(
          `/api/sodex/candles?symbol=${encodeURIComponent(symbol)}&market=${market}&interval=${interval}&limit=2`,
        );
        const j = await r.json();
        if (cancelled || !j.ok || !Array.isArray(j.candles)) return;
        const lastT = candlesRef.current[candlesRef.current.length - 1]?.time ?? 0;
        for (const c of j.candles as Candle[]) {
          if (c.time < lastT) continue; // never update older than the last bar
          candleRef.current?.update({
            time: c.time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          });
          volRef.current?.update({
            time: c.time,
            value: c.volume,
            color: c.close >= c.open ? VOL_UP : VOL_DOWN,
          });
          // keep the ref in sync so the legend/crosshair stay correct
          const arr = candlesRef.current;
          if (arr.length && arr[arr.length - 1].time === c.time) arr[arr.length - 1] = c;
          else arr.push(c);
        }
      } catch {
        /* keep last good */
      }
    };
    const t = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [ready, symbol, market, interval]);

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

  // Position (entry neutral, liq red-dashed), TP (green dashed) / SL (red
  // dashed), and open-order (side-coloured, labelled with size) price lines.
  // Cleared + redrawn when they change or the symbol switches.
  useEffect(() => {
    const series = candleRef.current;
    if (!ready || !series) return;
    for (const pl of tradeLinesRef.current) {
      try {
        series.removePriceLine(pl);
      } catch {
        /* no-op */
      }
    }
    tradeLinesRef.current = [];
    const add = (price: number, color: string, style: number, title: string) =>
      tradeLinesRef.current.push(
        series.createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle: style,
          axisLabelVisible: true,
          title,
        }),
      );
    const px = (n: number) => fmt(n, decimalsFromTick(tickSize));
    if (positionEntry != null && positionEntry > 0)
      add(positionEntry, NEUTRAL, 0, "Entry");
    if (positionLiq != null && positionLiq > 0)
      add(positionLiq, DOWN, 2, "Liq");
    if (tpPrice != null && tpPrice > 0) add(tpPrice, UP, 2, `TP ${px(tpPrice)}`);
    if (slPrice != null && slPrice > 0)
      add(slPrice, DOWN, 2, `SL ${px(slPrice)}`);
    for (const o of orderLines ?? []) {
      add(
        o.price,
        o.side === "buy" ? UP : DOWN,
        1,
        `${o.side === "buy" ? "Buy" : "Sell"} ${o.size}`,
      );
    }
    // Keep the active management levels (entry / TP / SL) in view, then force
    // the price scale to recompute so the dashed lines are always on-screen.
    levelsRef.current = [positionEntry, tpPrice, slPrice].filter(
      (v): v is number => v != null && v > 0,
    );
    try {
      series.priceScale().applyOptions({ autoScale: true });
    } catch {
      /* no-op */
    }
  }, [
    ready,
    positionEntry,
    positionLiq,
    tpPrice,
    slPrice,
    orderLines,
    symbol,
    tickSize,
    candles.length,
  ]);

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
        <a
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto pr-1 text-[9px] text-fg-dim transition-colors hover:text-fg-muted"
        >
          Charts by TradingView
        </a>
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
