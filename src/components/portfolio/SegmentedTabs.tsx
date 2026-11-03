"use client";

/**
 * SegmentedTabs — the portfolio's tab controls, in the terminal's two idioms:
 *   • "pill"      — the top-level Spot / Perpetuals switch (segmented pill).
 *   • "underline" — sub-tabs (Balances / Swap History / …), an accent underline
 *                    on the active tab, matching the bottom panel.
 */

import { cn } from "@/components/ui/cn";

export function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
  variant = "pill",
  counts,
  className,
}: {
  tabs: readonly T[];
  value: T;
  onChange: (t: T) => void;
  variant?: "pill" | "underline";
  /** Optional per-tab count badge (underline variant). */
  counts?: Partial<Record<T, number>>;
  className?: string;
}) {
  if (variant === "pill") {
    return (
      <div
        className={cn(
          "inline-flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5",
          className,
        )}
      >
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => onChange(t)}
            className={cn(
              "rounded-md px-4 py-1.5 text-[13px] font-medium transition-colors duration-150",
              t === value
                ? "bg-surface text-fg shadow-sm"
                : "text-fg-dim hover:text-fg-muted",
            )}
          >
            {t}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-4 overflow-x-auto text-[12px]",
        className,
      )}
    >
      {tabs.map((t) => {
        const count = counts?.[t];
        return (
          <button
            key={t}
            onClick={() => onChange(t)}
            className={cn(
              "relative flex shrink-0 items-center gap-1.5 whitespace-nowrap py-1 transition-colors",
              t === value
                ? "font-medium text-fg"
                : "text-fg-dim hover:text-fg-muted",
            )}
          >
            {t}
            {count != null && count > 0 ? (
              <span className="rounded bg-surface-2 px-1 text-[10px] tabular-nums text-fg-muted">
                {count}
              </span>
            ) : null}
            <span
              aria-hidden
              className="absolute inset-x-0 -bottom-[5px] h-[2px] rounded-full transition-opacity duration-150"
              style={{
                backgroundColor: "var(--accent-trade)",
                opacity: t === value ? 1 : 0,
              }}
            />
          </button>
        );
      })}
    </div>
  );
}
