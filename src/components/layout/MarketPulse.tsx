"use client";

/**
 * Market Pulse ribbon — persistent header strip showing current BTC/
 * ETH/SOL regime so the user always sees the tape state the agents
 * see. Sits under the Topbar on agent + signal pages.
 *
 * Refresh cadence: 30s. The underlying regime computation is ~50ms
 * (Turso query on `historical_klines_hourly`), so a tight cadence is
 * cheap and keeps the ribbon honest.
 */
import { useEffect, useState } from "react";

interface RegimeRow {
  symbol: string;
  trend?: "up" | "down" | "sideways";
  close?: number;
  drawdown_pct?: number;
  rsi_14?: number;
  days_since_ath?: number;
  return_30d_pct?: number | null;
  missing?: boolean;
}

interface PulseResponse {
  ok: boolean;
  computed_at: number;
  rows: RegimeRow[];
}

const TREND_STYLES = {
  up: {
    color: "var(--accent-positive)",
    dot: "var(--accent-positive)",
    label: "UP",
  },
  down: {
    color: "var(--accent-negative)",
    dot: "var(--accent-negative)",
    label: "DOWN",
  },
  sideways: {
    color: "var(--text-muted)",
    dot: "var(--text-muted)",
    label: "FLAT",
  },
} as const;

function formatClose(close: number | undefined): string {
  if (close == null) return "—";
  return close >= 1000
    ? `$${Math.round(close).toLocaleString()}`
    : `$${close.toFixed(2)}`;
}

function formatPct(x: number | null | undefined, withSign = false): string {
  if (x == null) return "—";
  const sign = withSign && x > 0 ? "+" : "";
  return `${sign}${x.toFixed(1)}%`;
}

export function MarketPulse() {
  const [pulse, setPulse] = useState<PulseResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchPulse = async () => {
      try {
        const res = await fetch("/api/data/market-pulse", { cache: "no-store" });
        const j = (await res.json()) as PulseResponse;
        if (!cancelled) {
          setPulse(j);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    };
    fetchPulse();
    const t = setInterval(fetchPulse, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (err || !pulse?.ok) return null;

  return (
    <div
      className="sticky z-[9] flex items-center gap-6 border-b border-line bg-bg/95 px-6 py-2 backdrop-blur"
      style={{ top: "3.5rem" /* under Topbar (h-14) */ }}
    >
      <span
        className="font-[var(--font-jetbrains-mono)] text-[10px] uppercase text-fg-dim"
        style={{ letterSpacing: "0.22em" }}
      >
        Market Pulse
      </span>
      <div className="flex flex-1 items-center gap-6 overflow-x-auto">
        {pulse.rows.map((r) => {
          if (r.missing) {
            return (
              <span key={r.symbol} className="text-xs text-fg-dim">
                {r.symbol}: no data
              </span>
            );
          }
          const style = TREND_STYLES[r.trend ?? "sideways"];
          return (
            <div key={r.symbol} className="flex items-center gap-2 text-xs">
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: 9999,
                  background: style.dot,
                }}
              />
              <span className="font-medium tabular text-fg">
                {r.symbol}
              </span>
              <span
                className="font-[var(--font-jetbrains-mono)] text-[10px] uppercase"
                style={{ letterSpacing: "0.15em", color: style.color }}
              >
                {style.label}
              </span>
              <span className="tabular text-fg">{formatClose(r.close)}</span>
              <span className="text-fg-dim">·</span>
              <span className="text-fg-muted">
                <span style={{ color: style.color }}>
                  {formatPct(r.drawdown_pct)}
                </span>{" "}
                from ATH
              </span>
              <span className="text-fg-dim">·</span>
              <span className="text-fg-muted">
                RSI{" "}
                <span className="tabular text-fg">
                  {r.rsi_14 != null ? Math.round(r.rsi_14) : "—"}
                </span>
              </span>
              <span className="text-fg-dim">·</span>
              <span className="text-fg-muted">
                30d{" "}
                <span style={{ color: style.color }}>
                  {formatPct(r.return_30d_pct, true)}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
