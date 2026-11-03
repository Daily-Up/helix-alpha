"use client";

/**
 * StatCard — one of the four headline metrics above a tab (Spot / Perps).
 * Label, a big mono value (optionally tone-coloured for signed PnL), and an
 * optional muted sub-line.
 */

import { cn } from "@/components/ui/cn";

export function StatCard({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  tone?: "default" | "positive" | "negative" | "muted";
}) {
  return (
    <div className="rounded-lg border border-line bg-surface-2/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-fg-dim">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-[var(--font-jetbrains-mono)] text-[18px] font-semibold leading-tight tabular-nums",
          tone === "positive" && "text-positive",
          tone === "negative" && "text-negative",
          tone === "muted" && "text-fg-muted",
          tone === "default" && "text-fg",
        )}
      >
        {value}
      </div>
      {sub != null && sub !== "" ? (
        <div className="mt-0.5 text-[10px] text-fg-dim">{sub}</div>
      ) : null}
    </div>
  );
}
