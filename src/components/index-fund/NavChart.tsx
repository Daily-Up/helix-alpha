"use client";

/**
 * NAV chart — AlphaCore vs BTC vs MAG7.ssi vs simple-rule benchmarks
 * (Part 2). All lines are normalized to 100 at the earliest data point
 * so they share a y-axis. The investor's first question on any index
 * product is "would I have made more money just holding BTC?" — this
 * chart now also asks "would a dumb rule have done better?"
 *
 * Series:
 *   • AlphaCore (accent colour, foreground, always on)
 *   • BTC (orange, the canonical crypto benchmark)
 *   • MAG7.ssi (purple, equity-side benchmark)
 *   • Naive momentum top-7 (cyan, toggle)
 *   • Hybrid 70/30 BTC+equities (green, toggle)
 *
 * The two simple-rule benchmarks are off by default to keep the chart
 * clean; the user clicks the legend chip to toggle each line on.
 */

import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface NavRow {
  date: string;
  nav_usd: number;
  pnl_pct: number;
  btc_price: number | null;
  ssimag7_price: number | null;
}

interface BenchmarkOverlay {
  name: "naive_momentum_top7" | "hybrid_simple";
  nav_by_date: Record<string, number>;
  return_pct: number;
  max_drawdown_pct: number;
  sharpe: number | null;
}

const BENCHMARK_LABELS: Record<BenchmarkOverlay["name"], string> = {
  naive_momentum_top7: "Naive momentum (top 7)",
  hybrid_simple: "Hybrid 70/30",
};

/** Normalize to 100 at the first point in `series`. Drops leading nulls. */
function normalize(series: Array<number | null>): Array<number | null> {
  const firstIdx = series.findIndex((v) => v != null && v > 0);
  if (firstIdx === -1) return series.map(() => null);
  const base = series[firstIdx]!;
  return series.map((v) => (v == null ? null : (v / base) * 100));
}

export function NavChart({
  history,
  isBackfill = false,
  benchmarkCurves = [],
}: {
  history: NavRow[];
  /** When true, render a "backtest" badge — the data is synthetic. */
  isBackfill?: boolean;
  /** Part 2 simple-rule overlays, keyed by date. Empty = no toggle shown. */
  benchmarkCurves?: BenchmarkOverlay[];
}) {
  // Benchmark visibility — both off by default; user opts in.
  const [showNaive, setShowNaive] = useState(false);
  const [showHybrid, setShowHybrid] = useState(false);

  if (history.length < 2) {
    return (
      <div className="flex h-72 items-center justify-center text-xs text-fg-dim">
        Not enough NAV history yet — chart appears after the second daily snapshot.
      </div>
    );
  }

  // Build normalized series so they share a 0-axis and the relative
  // outperformance is visible without a dual y-axis.
  const navSeries = normalize(history.map((r) => r.nav_usd));
  const btcSeries = normalize(history.map((r) => r.btc_price));
  const ssimag7Series = normalize(history.map((r) => r.ssimag7_price));

  // Pull benchmark NAVs aligned to the chart's dates. Missing dates
  // become null (visual gap rather than a flat line).
  const naive = benchmarkCurves.find((b) => b.name === "naive_momentum_top7");
  const hybrid = benchmarkCurves.find((b) => b.name === "hybrid_simple");
  const naiveSeries = normalize(
    history.map((r) => (naive ? naive.nav_by_date[r.date] ?? null : null)),
  );
  const hybridSeries = normalize(
    history.map((r) => (hybrid ? hybrid.nav_by_date[r.date] ?? null : null)),
  );

  // Only show benchmark lines we actually have data for. ssimag7 prices
  // depend on a kline backfill that isn't always available.
  const hasBtc = btcSeries.some((v) => v != null);
  const hasMag7 = ssimag7Series.some((v) => v != null);
  const hasNaive = naiveSeries.some((v) => v != null);
  const hasHybrid = hybridSeries.some((v) => v != null);

  const data = history.map((r, i) => ({
    date: r.date,
    nav: navSeries[i],
    btc: btcSeries[i],
    ssimag7: ssimag7Series[i],
    naive: showNaive ? naiveSeries[i] : null,
    hybrid: showHybrid ? hybridSeries[i] : null,
    nav_usd: r.nav_usd,
    btc_price: r.btc_price,
    ssimag7_price: r.ssimag7_price,
  }));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3 text-[11px]">
          <LegendDot color="#ff7a45" label="AlphaCore" />
          {hasBtc ? <LegendDot color="#f59e0b" label="BTC" /> : null}
          {hasMag7 ? <LegendDot color="#a855f7" label="MAG7.ssi" /> : null}
          {hasNaive ? (
            <LegendToggle
              color="#22d3ee"
              label={BENCHMARK_LABELS.naive_momentum_top7}
              active={showNaive}
              onClick={() => setShowNaive((v) => !v)}
            />
          ) : null}
          {hasHybrid ? (
            <LegendToggle
              color="#34d399"
              label={BENCHMARK_LABELS.hybrid_simple}
              active={showHybrid}
              onClick={() => setShowHybrid((v) => !v)}
            />
          ) : null}
        </div>
        {isBackfill ? (
          <span className="rounded border border-line-2 bg-surface-2 px-2 py-0.5 text-[10px] text-fg-dim">
            backtest · synthetic NAV from current allocation
          </span>
        ) : null}
      </div>
      <div className="h-72 w-full">
        <ResponsiveContainer>
          <LineChart
            data={data}
            margin={{ top: 8, right: 16, bottom: 8, left: -12 }}
          >
            <CartesianGrid stroke="#1a1f2a" strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "#7a8290" }}
              tickFormatter={(d: string) => d.slice(5)}
              stroke="#2a3340"
            />
            <YAxis
              tick={{ fontSize: 10, fill: "#7a8290" }}
              stroke="#2a3340"
              domain={["dataMin - 2", "dataMax + 2"]}
              tickFormatter={(v: number) => `${(v - 100).toFixed(1)}%`}
            />
            <Tooltip
              contentStyle={{
                background: "#0f1218",
                border: "1px solid #2a3340",
                borderRadius: 6,
                fontSize: 11,
                color: "#e6e9ef",
              }}
              labelStyle={{ color: "#9aa3b2" }}
              formatter={(value: unknown, name: unknown) => {
                const v = typeof value === "number" ? value : Number(value);
                if (!Number.isFinite(v)) return ["—", String(name)];
                const ret = (v - 100).toFixed(2);
                return [`${ret}%`, String(name)];
              }}
            />
            <Line
              type="monotone"
              dataKey="nav"
              name="AlphaCore"
              stroke="#ff7a45"
              strokeWidth={2.5}
              dot={false}
              isAnimationActive={false}
            />
            {hasBtc ? (
              <Line
                type="monotone"
                dataKey="btc"
                name="BTC"
                stroke="#f59e0b"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            ) : null}
            {hasMag7 ? (
              <Line
                type="monotone"
                dataKey="ssimag7"
                name="MAG7.ssi"
                stroke="#a855f7"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            ) : null}
            {showNaive && hasNaive ? (
              <Line
                type="monotone"
                dataKey="naive"
                name="Naive momentum"
                stroke="#22d3ee"
                strokeWidth={1.5}
                strokeDasharray="4 2"
                dot={false}
                isAnimationActive={false}
              />
            ) : null}
            {showHybrid && hasHybrid ? (
              <Line
                type="monotone"
                dataKey="hybrid"
                name="Hybrid 70/30"
                stroke="#34d399"
                strokeWidth={1.5}
                strokeDasharray="4 2"
                dot={false}
                isAnimationActive={false}
              />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Benchmark mini-table — return / DD / Sharpe per simple-rule
          comparator. Only shown when at least one overlay has data. */}
      {hasNaive || hasHybrid ? (
        <div className="mt-1 grid grid-cols-3 gap-2 rounded border border-line bg-surface-2 px-3 py-2 text-[11px]">
          <div className="text-fg-dim">benchmark</div>
          <div className="text-right text-fg-dim">return / DD</div>
          <div className="text-right text-fg-dim">Sharpe</div>
          {hasNaive && naive ? (
            <>
              <div className="text-fg">Naive momentum (top 7)</div>
              <div className="tabular text-right">
                <span className={naive.return_pct >= 0 ? "text-positive" : "text-negative"}>
                  {fmtPct(naive.return_pct)}
                </span>
                <span className="text-fg-dim"> · </span>
                <span className="text-negative">{naive.max_drawdown_pct.toFixed(1)}%</span>
              </div>
              <div className="tabular text-right text-fg">
                {naive.sharpe != null ? naive.sharpe.toFixed(2) : "—"}
              </div>
            </>
          ) : null}
          {hasHybrid && hybrid ? (
            <>
              <div className="text-fg">Hybrid 70/30</div>
              <div className="tabular text-right">
                <span className={hybrid.return_pct >= 0 ? "text-positive" : "text-negative"}>
                  {fmtPct(hybrid.return_pct)}
                </span>
                <span className="text-fg-dim"> · </span>
                <span className="text-negative">{hybrid.max_drawdown_pct.toFixed(1)}%</span>
              </div>
              <div className="tabular text-right text-fg">
                {hybrid.sharpe != null ? hybrid.sharpe.toFixed(2) : "—"}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-fg-muted">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

function LegendToggle({
  color,
  label,
  active,
  onClick,
}: {
  color: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex items-center gap-1.5 rounded border px-1.5 py-0.5 transition-colors " +
        (active
          ? "border-line-2 bg-surface text-fg"
          : "border-line bg-surface-2 text-fg-dim hover:text-fg-muted")
      }
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: active ? color : "#3a4250" }}
      />
      {label}
    </button>
  );
}
