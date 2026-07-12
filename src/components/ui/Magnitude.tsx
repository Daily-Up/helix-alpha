import { cn } from "./cn";
import { Num, type NumTier } from "./Num";

/**
 * THE key primitive. A numeric cell with an inline bar behind it, scaled to
 * the column max — so the reader SEES the ratio instead of computing it.
 * `tone="auto"` colours the bar by sign (green up / red down).
 */
export function Magnitude({
  value,
  max,
  unit,
  sign,
  dp,
  compact,
  tone,
  tier,
  className,
}: {
  value: number | null | undefined;
  /** Column max (absolute). Bar width = |value| / max. */
  max: number;
  unit?: string;
  sign?: boolean;
  dp?: number;
  compact?: boolean;
  tone?: "positive" | "negative" | "auto";
  tier?: NumTier;
  className?: string;
}) {
  const has = value != null && !Number.isNaN(value);
  const a = has ? Math.abs(value as number) : 0;
  const pct = max > 0 ? Math.min(100, (a / max) * 100) : 0;
  const negative = has && (value as number) < 0;
  const barTone =
    tone === "auto"
      ? negative
        ? "bg-negative/45"
        : "bg-positive/45"
      : tone === "negative"
        ? "bg-negative/45"
        : tone === "positive"
          ? "bg-positive/45"
          : "bg-accent/40";

  return (
    <div className={cn("relative flex items-center justify-end px-2", className)}>
      {has && pct > 0 ? (
        <div
          aria-hidden
          className={cn("absolute inset-y-[3px] left-0 rounded-[2px]", barTone)}
          style={{ width: `${pct}%` }}
        />
      ) : null}
      <span className="relative z-[1]">
        <Num
          value={value}
          unit={unit}
          sign={sign}
          dp={dp}
          compact={compact}
          tone={tone}
          tier={tier}
        />
      </span>
    </div>
  );
}
