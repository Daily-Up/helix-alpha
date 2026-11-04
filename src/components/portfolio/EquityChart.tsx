"use client";

/**
 * EquityChart — the portfolio's equity/PnL curve, built from our own snapshots
 * (SoDEX has no equity-history endpoint). Perpetuals / Spot / Total and Equity
 * / PnL dropdowns pick the series; a 1D/1W/1M/All toggle picks the window. The
 * big number is the current value; beneath it the range change in $ and % with
 * a coloured arrow. Area series (lightweight-charts), line coloured by the sign
 * of the change, soft gradient fill, right price axis, crosshair. Until two
 * points exist it shows "History starts <date>" over the current value.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { money, signedMoney, signedPct, fmtDate } from "./fmt";

interface SnapshotRow {
  ts: number;
  perps_equity: number;
  spot_equity: number;
  total_equity: number;
  perps_upnl: number | null;
}

type Portfolio = "Perpetuals" | "Spot" | "Total";
type Metric = "Equity" | "PnL";
const RANGES = ["1D", "1W", "1M", "all"] as const;
type Range = (typeof RANGES)[number];
const RANGE_LABEL: Record<Range, string> = {
  "1D": "1D",
  "1W": "1W",
  "1M": "1M",
  all: "All",
};

const UP = "#0ecb81";
const DOWN = "#f6465d";
const rgba = (hex: string, a: number) => {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
};

const two = (x: number) => String(x).padStart(2, "0");

/** Axis tick label sized to the ACTUAL plotted span (not the range toggle), so a
 *  cluster of same-day snapshots shows times instead of one repeated date:
 *  < 2 days → "14:05", < 2 months → "Mon 3", else "3 Nov". */
function axisLabel(timeSec: number, spanDays: number): string {
  const d = new Date(timeSec * 1000);
  if (spanDays < 2) return `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (spanDays < 60)
    return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.getDate()}`;
  return `${d.getDate()} ${d.toLocaleDateString(undefined, { month: "short" })}`;
}

/** Crosshair label — always date + time for precision on hover. */
function crosshairLabel(timeSec: number): string {
  const d = new Date(timeSec * 1000);
  return `${d.getDate()} ${d.toLocaleDateString(undefined, { month: "short" })} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function EquityChart({
  address,
  liveTotals,
}: {
  address: string | null;
  /** Live equity per portfolio (from the unified balances) — appended as the
   *  final point so the line ends at the current number and the headline equals
   *  the Overview total. */
  liveTotals: { perps: number; spot: number; total: number } | null;
}) {
  const [portfolio, setPortfolio] = useState<Portfolio>("Total");
  const [metric, setMetric] = useState<Metric>("Equity");
  const [range, setRange] = useState<Range>("1W");
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [earliestTs, setEarliestTs] = useState<number | null>(null);
  const [hover, setHover] = useState<{ value: number; time: number } | null>(
    null,
  );

  // Pull the snapshot series for this address + range.
  useEffect(() => {
    if (!address) {
      setRows([]);
      setEarliestTs(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/portfolio/equity-snapshot?address=${address}&range=${range}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled || !j.ok) return;
        setRows(j.series ?? []);
        setEarliestTs(j.earliestTs ?? null);
      })
      .catch(() => {
        /* keep last good */
      });
    return () => {
      cancelled = true;
    };
  }, [address, range]);

  const pickEquity = useMemo(() => {
    return (r: SnapshotRow) =>
      portfolio === "Perpetuals"
        ? r.perps_equity
        : portfolio === "Spot"
          ? r.spot_equity
          : r.total_equity;
  }, [portfolio]);

  const liveEquity =
    liveTotals == null
      ? null
      : portfolio === "Perpetuals"
        ? liveTotals.perps
        : portfolio === "Spot"
          ? liveTotals.spot
          : liveTotals.total;

  // Snapshot points (time in seconds, deduped + ascending).
  const snapPts = useMemo(() => {
    const map = new Map<number, number>();
    for (const r of rows) map.set(Math.floor(r.ts / 1000), pickEquity(r));
    return [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([time, equity]) => ({ time, equity }));
  }, [rows, pickEquity]);

  // Append the live value as the final point, so the line ends at the current
  // number and the headline matches the Overview total exactly (Task: one total).
  const equityPts = useMemo(() => {
    if (liveEquity == null) return snapPts;
    const lastSec = snapPts.length ? snapPts[snapPts.length - 1].time : 0;
    const liveSec = Math.max(Math.floor(Date.now() / 1000), lastSec + 60);
    return [...snapPts, { time: liveSec, equity: liveEquity }];
  }, [snapPts, liveEquity]);

  const baseEq = equityPts[0]?.equity ?? 0;
  // Metric transform: PnL is 0-anchored at the range start.
  const points = useMemo(
    () =>
      equityPts.map((p) => ({
        time: p.time,
        value: metric === "PnL" ? p.equity - baseEq : p.equity,
      })),
    [equityPts, metric, baseEq],
  );

  const firstEq = equityPts[0]?.equity ?? liveEquity ?? null;
  const lastEq =
    equityPts[equityPts.length - 1]?.equity ?? liveEquity ?? null;
  const changeAbs =
    lastEq != null && firstEq != null ? lastEq - firstEq : null;
  const changePct =
    changeAbs != null && firstEq != null && Math.abs(firstEq) > 1e-9
      ? (changeAbs / Math.abs(firstEq)) * 100
      : null;
  const up = (changeAbs ?? 0) >= 0;
  const color = up ? UP : DOWN;

  // Current headline value for the selected metric.
  const headline =
    points.length > 0
      ? points[points.length - 1].value
      : metric === "PnL"
        ? 0
        : liveEquity;
  const sparse = equityPts.length < 2;
  // Count ACTUAL snapshots (not the appended live point) for the note; with a
  // handful the line reads sparse, so dot each point and show the count.
  const snapCount = snapPts.length;
  const fewPoints = snapCount >= 2 && snapCount <= 30;
  // Axis label format follows the REAL plotted span (see axisLabel).
  const spanDays = useMemo(() => {
    if (equityPts.length < 2) return 0;
    return (equityPts[equityPts.length - 1].time - equityPts[0].time) / 86400;
  }, [equityPts]);

  // ── chart ──
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seriesRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const pointsRef = useRef(points);
  pointsRef.current = points;
  // The tick formatter is installed once but must track the live plotted span.
  const spanRef = useRef(spanDays);
  spanRef.current = spanDays;

  useEffect(() => {
    let disposed = false;
    (async () => {
      const el = containerRef.current;
      if (!el) return;
      const LWC = await import("lightweight-charts");
      if (disposed || !containerRef.current) return;
      const chart = LWC.createChart(containerRef.current, {
        localization: {
          priceFormatter: (p: number) =>
            (p < 0 ? "-$" : "$") +
            Math.abs(p).toLocaleString(undefined, {
              maximumFractionDigits: Math.abs(p) >= 1000 ? 0 : 2,
            }),
          timeFormatter: (t: unknown) =>
            typeof t === "number" ? crosshairLabel(t) : "",
        },
        layout: {
          background: { type: LWC.ColorType.Solid, color: "transparent" },
          textColor: "rgba(190,190,195,0.55)",
          fontSize: 11,
          fontFamily: "var(--font-jetbrains-mono), monospace",
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: "rgba(255,255,255,0.03)" },
          horzLines: { color: "rgba(255,255,255,0.03)" },
        },
        rightPriceScale: {
          borderColor: "rgba(255,255,255,0.06)",
          scaleMargins: { top: 0.12, bottom: 0.08 },
        },
        timeScale: {
          borderColor: "rgba(255,255,255,0.06)",
          timeVisible: true,
          secondsVisible: false,
          tickMarkFormatter: (t: unknown) =>
            typeof t === "number" ? axisLabel(t, spanRef.current) : "",
        },
        crosshair: {
          mode: LWC.CrosshairMode.Normal,
          vertLine: {
            color: "rgba(230,232,235,0.22)",
            labelBackgroundColor: "#171c23",
          },
          horzLine: {
            color: "rgba(230,232,235,0.22)",
            labelBackgroundColor: "#171c23",
          },
        },
        autoSize: true,
      });
      const series = chart.addAreaSeries({
        lineColor: UP,
        topColor: rgba(UP, 0.28),
        bottomColor: rgba(UP, 0.02),
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: true,
      });
      chartRef.current = chart;
      seriesRef.current = series;
      chart.subscribeCrosshairMove((param: { time?: unknown; seriesData?: Map<unknown, unknown> }) => {
        const data = pointsRef.current;
        if (!param.time) {
          setHover(null);
          return;
        }
        const hit = data.find((p) => p.time === param.time);
        setHover(hit ? { value: hit.value, time: hit.time } : null);
      });
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

  // Push data + recolour on sign change.
  useEffect(() => {
    if (!ready || !seriesRef.current) return;
    const few = points.length >= 2 && points.length <= 30;
    seriesRef.current.applyOptions({
      lineColor: color,
      topColor: rgba(color, 0.28),
      bottomColor: rgba(color, 0.02),
      pointMarkersVisible: few,
      pointMarkersRadius: 3,
    });
    seriesRef.current.setData(points);
    chartRef.current?.timeScale().fitContent();
  }, [points, color, ready]);

  const shownValue = hover ? hover.value : headline;

  return (
    <div className="trade-terminal flex h-full flex-col rounded-lg border border-line bg-surface">
      {/* Controls + headline */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-2">
            <Dropdown
              value={portfolio}
              onChange={(v) => setPortfolio(v as Portfolio)}
              options={["Perpetuals", "Spot", "Total"]}
            />
            <Dropdown
              value={metric}
              onChange={(v) => setMetric(v as Metric)}
              options={["Equity", "PnL"]}
            />
          </div>
          <div className="flex flex-col">
            <span className="font-[var(--font-jetbrains-mono)] text-[30px] font-semibold leading-none tabular-nums text-fg">
              {metric === "PnL" && (shownValue ?? 0) !== 0
                ? signedMoney(shownValue)
                : money(shownValue)}
            </span>
            <div className="mt-1.5 flex items-center gap-2 text-[12px]">
              <span
                className={cn(
                  "inline-flex items-center gap-1 font-[var(--font-jetbrains-mono)] tabular-nums",
                  changeAbs == null
                    ? "text-fg-dim"
                    : up
                      ? "text-positive"
                      : "text-negative",
                )}
              >
                {changeAbs != null ? (
                  <span aria-hidden>{up ? "▲" : "▼"}</span>
                ) : null}
                {signedMoney(changeAbs)}
                {changePct != null ? ` (${signedPct(changePct)})` : ""}
              </span>
              <span className="text-fg-dim">· {RANGE_LABEL[range]}</span>
              {fewPoints ? (
                <span className="text-fg-dim">· {snapCount} snapshots</span>
              ) : null}
            </div>
          </div>
        </div>

        {/* Range toggle */}
        <div className="flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={cn(
                "rounded px-2.5 py-1 text-[11px] font-medium tabular-nums transition-colors duration-150",
                r === range
                  ? "bg-surface text-fg shadow-sm"
                  : "text-fg-dim hover:text-fg-muted",
              )}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="relative min-h-0 flex-1 px-2 py-2">
        <div ref={containerRef} className="h-full w-full" />
        {!address ? (
          <Overlay>Connect a SoDEX wallet to chart your equity.</Overlay>
        ) : sparse ? (
          <Overlay>
            {earliestTs
              ? `History starts ${fmtDate(earliestTs)} — the curve fills in as snapshots record (every ~15 min you're here, plus a daily backstop).`
              : "History starts now — your equity is being recorded; the curve fills in over the next snapshots."}
          </Overlay>
        ) : null}
      </div>
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      <div className="max-w-sm rounded-lg border border-line bg-surface/85 px-4 py-3 text-center text-[12px] leading-relaxed text-fg-muted backdrop-blur">
        {children}
      </div>
    </div>
  );
}

function Dropdown({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="cursor-pointer appearance-none rounded-md border border-line bg-surface-2 py-1 pl-2.5 pr-7 text-[12px] font-medium text-fg transition-colors hover:border-line-2 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-fg-dim"
      >
        ▼
      </span>
    </div>
  );
}
