import { cn } from "./cn";
import { formatNum } from "@/lib/format/num";
import { Empty } from "./Empty";

/** Three-step numeric scale — every number in the app lands on one. */
export type NumTier = "lead" | "secondary" | "context";

const TIER: Record<NumTier, string> = {
  lead: "text-[22px] leading-none font-medium text-fg",
  secondary: "text-[14px] text-fg",
  context: "text-[12px] text-fg-muted",
};

export interface NumProps {
  value: number | null | undefined;
  /** "$" prefix, "%" suffix, or a unit suffix like "USDC". */
  unit?: string;
  sign?: boolean;
  dp?: number;
  compact?: boolean;
  tier?: NumTier;
  /** "auto" colours by sign (green/red); zero always recedes. */
  tone?: "positive" | "negative" | "auto";
  className?: string;
}

/**
 * The ONE number component. Precision comes from magnitude class, not the
 * API. Always tabular-nums. Full precision on hover (title). Zero recedes.
 */
export function Num({
  value,
  unit,
  sign,
  dp,
  compact,
  tier = "secondary",
  tone,
  className,
}: NumProps) {
  const p = formatNum(value, { unit, sign, dp, compact });
  if (p.isEmpty) return <Empty className={cn(TIER[tier], className)} />;

  const toneClass =
    tone === "positive"
      ? "text-positive"
      : tone === "negative"
        ? "text-negative"
        : tone === "auto"
          ? p.isNegative
            ? "text-negative"
            : p.isZero
              ? ""
              : "text-positive"
          : "";

  return (
    <span
      title={p.title}
      className={cn(
        "tabular-nums",
        TIER[tier],
        toneClass,
        p.isZero && "text-fg-dim opacity-60", // zero recedes
        className,
      )}
    >
      {p.text}
    </span>
  );
}
