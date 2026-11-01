"use client";

/**
 * SetupCard — renders a /api/setup response: the directional call, the
 * reasoning, the key levels and trade plan, and the SoSoValue headlines
 * that drove it. The cited sources are the point — a setup you can audit.
 */

import { cn } from "@/components/ui/cn";

export interface SetupLevel {
  kind: "support" | "resistance";
  price: number;
  label: string;
}
export interface SetupBody {
  bias: "bullish" | "bearish" | "neutral";
  direction: "long" | "short" | "none";
  conviction: number;
  horizon: string;
  tldr: string;
  reasoning: string;
  key_levels: SetupLevel[];
  entry: number | null;
  target: number | null;
  stop: number | null;
  catalysts: string[];
}
export interface SetupSource {
  title: string;
  event_type: string;
  sentiment: string;
  severity: string;
  classified_at: number;
}
export interface SetupResponse {
  asset: { id: string; symbol: string; name: string; sodex_symbol: string | null };
  setup: SetupBody;
  price: {
    current: number | null;
    mark: number | null;
    change_7d_pct: number | null;
    change_30d_pct: number | null;
  };
  sources: SetupSource[];
  generated_at: number;
  model: string;
}

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: 4 });

const BIAS_STYLE: Record<SetupBody["bias"], { dot: string; text: string; label: string }> = {
  bullish: { dot: "bg-positive", text: "text-positive", label: "Bullish" },
  bearish: { dot: "bg-negative", text: "text-negative", label: "Bearish" },
  neutral: { dot: "bg-fg-dim", text: "text-fg-muted", label: "Neutral" },
};

export function SetupCard({ data }: { data: SetupResponse }) {
  const { setup, asset, price, sources } = data;
  const bias = BIAS_STYLE[setup.bias];
  const dirLong = setup.direction === "long";
  const dirShort = setup.direction === "short";

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      {/* Headline: the call */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className={cn("h-2.5 w-2.5 rounded-full", bias.dot)} />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-[var(--font-fraunces)] text-[18px] text-fg">
                {asset.symbol}
              </span>
              {setup.direction !== "none" ? (
                <span
                  className={cn(
                    "rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                    dirLong && "border-positive/40 bg-positive/10 text-positive",
                    dirShort && "border-negative/40 bg-negative/10 text-negative",
                  )}
                >
                  {setup.direction}
                </span>
              ) : null}
              <span className={cn("text-[12px] font-medium", bias.text)}>
                {bias.label}
              </span>
            </div>
            <div className="text-[11px] text-fg-dim">
              {asset.name} · {setup.horizon}
            </div>
          </div>
        </div>
        {/* Conviction */}
        <div className="text-right">
          <div className="font-[var(--font-jetbrains-mono)] text-[10px] uppercase tracking-wider text-fg-dim">
            Conviction
          </div>
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-2">
              <div
                className={cn("h-full rounded-full", bias.dot)}
                style={{ width: `${Math.max(0, Math.min(100, setup.conviction))}%` }}
              />
            </div>
            <span className="text-[13px] font-semibold text-fg">
              {Math.round(setup.conviction)}
            </span>
          </div>
        </div>
      </div>

      {/* TL;DR */}
      <p className="text-[14px] leading-snug text-fg">{setup.tldr}</p>

      {/* Price context */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11.5px] text-fg-muted">
        <span>
          Price <span className="text-fg">{fmt(price.current)}</span>
        </span>
        {price.change_7d_pct != null ? (
          <span>
            7d{" "}
            <span className={price.change_7d_pct >= 0 ? "text-positive" : "text-negative"}>
              {price.change_7d_pct >= 0 ? "+" : ""}
              {price.change_7d_pct.toFixed(1)}%
            </span>
          </span>
        ) : null}
        {price.change_30d_pct != null ? (
          <span>
            30d{" "}
            <span className={price.change_30d_pct >= 0 ? "text-positive" : "text-negative"}>
              {price.change_30d_pct >= 0 ? "+" : ""}
              {price.change_30d_pct.toFixed(1)}%
            </span>
          </span>
        ) : null}
      </div>

      {/* Reasoning */}
      <p className="text-[12.5px] leading-relaxed text-fg-muted">{setup.reasoning}</p>

      {/* Trade plan */}
      {setup.entry != null || setup.target != null || setup.stop != null ? (
        <div className="grid grid-cols-3 gap-2">
          <Plan label="Entry" value={fmt(setup.entry)} tone="neutral" />
          <Plan label="Target" value={fmt(setup.target)} tone="positive" />
          <Plan label="Stop" value={fmt(setup.stop)} tone="negative" />
        </div>
      ) : null}

      {/* Key levels */}
      {setup.key_levels.length ? (
        <div>
          <div className="mb-1.5 font-[var(--font-jetbrains-mono)] text-[10px] uppercase tracking-wider text-fg-dim">
            Key levels
          </div>
          <ul className="flex flex-col gap-1">
            {setup.key_levels.map((lv, i) => (
              <li
                key={i}
                className="flex items-center justify-between rounded border border-line bg-surface-2 px-2.5 py-1.5 text-[12px]"
              >
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase",
                      lv.kind === "support"
                        ? "bg-positive/10 text-positive"
                        : "bg-negative/10 text-negative",
                    )}
                  >
                    {lv.kind === "support" ? "S" : "R"}
                  </span>
                  <span className="text-fg-muted">{lv.label}</span>
                </span>
                <span className="font-[var(--font-jetbrains-mono)] text-fg">
                  {fmt(lv.price)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Catalysts */}
      {setup.catalysts.length ? (
        <div className="flex flex-wrap gap-1.5">
          {setup.catalysts.map((c, i) => (
            <span
              key={i}
              className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10.5px] text-accent-2"
            >
              {c}
            </span>
          ))}
        </div>
      ) : null}

      {/* Sources — the auditable edge */}
      <div className="border-t border-line pt-3">
        <div className="mb-1.5 font-[var(--font-jetbrains-mono)] text-[10px] uppercase tracking-wider text-fg-dim">
          {sources.length ? `Grounded in ${sources.length} SoSoValue headlines` : "No recent news for this asset"}
        </div>
        <ul className="flex flex-col gap-1">
          {sources.slice(0, 6).map((s, i) => (
            <li key={i} className="flex items-start gap-2 text-[11.5px] text-fg-muted">
              <span
                className={cn(
                  "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                  s.sentiment === "positive"
                    ? "bg-positive"
                    : s.sentiment === "negative"
                      ? "bg-negative"
                      : "bg-fg-dim",
                )}
              />
              <span>
                <span className="text-fg-dim">[{s.event_type}]</span> {s.title}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Plan({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "neutral" | "positive" | "negative";
}) {
  return (
    <div className="rounded border border-line bg-surface-2 px-2.5 py-1.5">
      <div className="font-[var(--font-jetbrains-mono)] text-[9px] uppercase tracking-wider text-fg-dim">
        {label}
      </div>
      <div
        className={cn(
          "font-[var(--font-jetbrains-mono)] text-[13px]",
          tone === "positive" && "text-positive",
          tone === "negative" && "text-negative",
          tone === "neutral" && "text-fg",
        )}
      >
        {value}
      </div>
    </div>
  );
}
