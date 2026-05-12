import { cn } from "./cn";

type Tone =
  | "default"
  | "positive"
  | "negative"
  | "neutral"
  | "info"
  | "warning"
  | "accent";

/**
 * Editorial tone — quiet background tints (≤8% alpha) with a small-caps
 * label. Reads as a typographic accent, not a Bloomberg-terminal chip.
 */
const toneStyle: Record<Tone, { bg: string; fg: string; border: string }> = {
  default:  { bg: "transparent",            fg: "#8a857a", border: "rgba(237, 228, 211, 0.10)" },
  positive: { bg: "rgba(92, 201, 122, 0.07)", fg: "#5cc97a", border: "rgba(92, 201, 122, 0.22)" },
  negative: { bg: "rgba(224, 108, 102, 0.07)", fg: "#e06c66", border: "rgba(224, 108, 102, 0.22)" },
  neutral:  { bg: "transparent",            fg: "#8a857a", border: "rgba(237, 228, 211, 0.10)" },
  info:     { bg: "rgba(127, 169, 209, 0.07)", fg: "#7fa9d1", border: "rgba(127, 169, 209, 0.22)" },
  warning:  { bg: "rgba(209, 168, 90, 0.07)", fg: "#d1a85a", border: "rgba(209, 168, 90, 0.22)" },
  accent:   { bg: "rgba(217, 119, 87, 0.07)", fg: "#d97757", border: "rgba(217, 119, 87, 0.26)" },
};

export function Badge({
  children,
  tone = "default",
  className,
  mono = true,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
  mono?: boolean;
}) {
  const style = toneStyle[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap",
        mono ? "font-[var(--font-jetbrains-mono)]" : "font-[var(--font-inter)]",
        className,
      )}
      style={{
        background: style.bg,
        color: style.fg,
        border: `1px solid ${style.border}`,
        fontSize: "9px",
        fontWeight: 600,
        letterSpacing: "0.18em",
        padding: "3px 7px",
        borderRadius: "2px",
        textTransform: "uppercase",
        lineHeight: 1,
      }}
    >
      {children}
    </span>
  );
}
