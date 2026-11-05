"use client";

/**
 * PriceChart — TradingView-grade candlestick + volume chart for the Trade
 * Terminal, fed by live SoDEX klines. OHLC legend tracks the crosshair,
 * volume sits in the lower band, and Setup levels draw as price lines.
 * lightweight-charts is imported inside the effect so it never SSRs.
 */

import { memo, useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import type { SetupLevel } from "./SetupCard";

const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
type Interval = (typeof INTERVALS)[number];
const INTERVAL_LABEL: Record<Interval, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1H",
  "4h": "4H",
  "1d": "1D",
};

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const UP = "#0ecb81";
const DOWN = "#f6465d";
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

function PriceChartImpl({
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
  // Entry price the autoscale may nudge the range to include (only when it's
  // within ~5% of the candle range). TP/SL/order lines are NOT kept in view —
  // off-screen ones get an edge marker instead.
  const entryRef = useRef<number | null>(null);
  // Edge markers for off-screen lines: { text, color, dir }.
  const [edges, setEdges] = useState<
    { text: string; color: string; dir: "up" | "down" }[]
  >([]);

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
          vertLine: { color: "rgba(230,232,235,0.22)", labelBackgroundColor: "#171c23" },
          horzLine: { color: "rgba(230,232,235,0.22)", labelBackgroundColor: "#171c23" },
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
        // Autoscale to the CANDLES only — never stretch to TP/SL/order lines
        // (that squashes the candles). The one exception: nudge the range to
        // include the entry when it's within ~5% of the candle range, so the
        // entry line stays visible without distorting the chart. Off-screen
        // TP/SL/order lines get an edge marker instead (see edge effect).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        autoscaleInfoProvider: (orig: () => any) => {
          const res = orig();
          const entry = entryRef.current;
          if (!res || !res.priceRange || entry == null || entry <= 0) return res;
          const { minValue, maxValue } = res.priceRange;
          const pad = (maxValue - minValue) * 0.05;
          if (entry < minValue - pad || entry > maxValue + pad) return res;
          return {
            ...res,
            priceRange: {
              minValue: Math.min(minValue, entry),
              maxValue: Math.max(maxValue, entry),
            },
          };
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

    // Candle price range (the autoscale target). Any TP/SL/liq/order line OUTSIDE
    // this range is NOT drawn as a price line — it becomes an edge marker on the
    // price axis instead, so the scale is never stretched to fit it.
    let cMax = -Infinity;
    let cMin = Infinity;
    for (const c of candles) {
      if (c.high > cMax) cMax = c.high;
      if (c.low < cMin) cMin = c.low;
    }
    const hasRange = Number.isFinite(cMax) && Number.isFinite(cMin);
    const out: { text: string; color: string; dir: "up" | "down" }[] = [];
    const place = (
      price: number,
      color: string,
      style: number,
      lineTitle: string,
      edgeLabel: string,
    ) => {
      if (!hasRange || (price >= cMin && price <= cMax)) {
        add(price, color, style, lineTitle);
      } else if (price > cMax) {
        out.push({ text: `${edgeLabel} ↑`, color, dir: "up" });
      } else {
        out.push({ text: `${edgeLabel} ↓`, color, dir: "down" });
      }
    };

    // Entry stays a price line (the autoscale nudges it into view when within
    // ~5%). TP / SL / Liq / orders follow the same edge-or-line rule.
    if (positionEntry != null && positionEntry > 0)
      add(positionEntry, NEUTRAL, 0, "Entry");
    if (positionLiq != null && positionLiq > 0)
      place(positionLiq, DOWN, 2, "Liq", `Liq ${px(positionLiq)}`);
    if (tpPrice != null && tpPrice > 0)
      place(tpPrice, UP, 2, `TP ${px(tpPrice)}`, `TP ${px(tpPrice)}`);
    if (slPrice != null && slPrice > 0)
      place(slPrice, DOWN, 2, `SL ${px(slPrice)}`, `SL ${px(slPrice)}`);
    for (const o of orderLines ?? []) {
      const label = o.side === "buy" ? "Buy" : "Sell";
      place(o.price, o.side === "buy" ? UP : DOWN, 1, `${label} ${o.size}`, `${label} ${px(o.price)}`);
    }

    entryRef.current = positionEntry != null && positionEntry > 0 ? positionEntry : null;
    try {
      series.priceScale().applyOptions({ autoScale: true });
    } catch {
      /* no-op */
    }
    setEdges((prev) =>
      prev.length === out.length &&
      prev.every((p, i) => p.text === out[i].text && p.dir === out[i].dir)
        ? prev
        : out,
    );
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
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 pb-2">
        <div className="flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5">
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              onClick={() => setIntervalSel(iv)}
              className={cn(
                "rounded px-2 py-1 text-[11px] font-medium tabular-nums transition-colors duration-150",
                iv === interval
                  ? "bg-surface text-fg shadow-sm"
                  : "text-fg-dim hover:text-fg-muted",
              )}
            >
              {INTERVAL_LABEL[iv]}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-fg-dim">
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
        {/* Edge markers for TP/SL/order lines outside the visible price range. */}
        {edges.some((e) => e.dir === "up") ? (
          <div className="pointer-events-none absolute right-[60px] top-1 z-10 flex flex-col items-end gap-0.5">
            {edges
              .filter((e) => e.dir === "up")
              .map((e, i) => (
                <span
                  key={i}
                  className="rounded px-1 py-0.5 text-[9px] font-semibold tabular-nums"
                  style={{ color: e.color, background: "rgba(10,12,16,0.6)" }}
                >
                  {e.text}
                </span>
              ))}
          </div>
        ) : null}
        {edges.some((e) => e.dir === "down") ? (
          <div className="pointer-events-none absolute bottom-[28px] right-[60px] z-10 flex flex-col items-end gap-0.5">
            {edges
              .filter((e) => e.dir === "down")
              .map((e, i) => (
                <span
                  key={i}
                  className="rounded px-1 py-0.5 text-[9px] font-semibold tabular-nums"
                  style={{ color: e.color, background: "rgba(10,12,16,0.6)" }}
                >
                  {e.text}
                </span>
              ))}
          </div>
        ) : null}
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

// Memoized: its props (symbol, label, levels, position lines, tickSize) are all
// stable across the terminal's 1s clock tick and 3–5s market polls, so the
// chart no longer re-renders on every parent render — only when its own inputs
// actually change.
export const PriceChart = memo(PriceChartImpl);
