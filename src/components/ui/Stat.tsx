import { cn } from "./cn";

const TEXT_BRAND = "#ede4d3";
const TEXT_MUTED = "#8a857a";
const TEXT_DIM = "#5d584e";
const POSITIVE = "#5cc97a";
const NEGATIVE = "#e06c66";
const ACCENT = "#d97757";
const BORDER_QUIET = "rgba(237, 228, 211, 0.08)";

/**
 * Headline stat — editorial small-caps label, larger Fraunces-or-mono value,
 * hairline top border instead of a rounded card box. Used in the row of
 * supporting stats beneath each dashboard's hero number.
 */
export function Stat({
  label,
  value,
  sub,
  tone = "default",
  className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "default" | "positive" | "negative" | "accent";
  className?: string;
}) {
  const valueColor =
    tone === "positive"
      ? POSITIVE
      : tone === "negative"
        ? NEGATIVE
        : tone === "accent"
          ? ACCENT
          : TEXT_BRAND;

  return (
    <div
      className={cn("flex flex-col gap-1 py-3", className)}
      style={{ borderTop: `1px solid ${BORDER_QUIET}` }}
    >
      <div
        className="font-[var(--font-jetbrains-mono)] uppercase"
        style={{
          fontSize: "10px",
          fontWeight: 500,
          letterSpacing: "0.16em",
          color: TEXT_DIM,
        }}
      >
        {label}
      </div>
      <div
        className="font-[var(--font-fraunces)] tabular-nums"
        style={{
          fontSize: "26px",
          fontWeight: 400,
          color: valueColor,
          letterSpacing: "-0.018em",
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      {sub ? (
        <div
          className="font-[var(--font-inter)]"
          style={{ fontSize: "11.5px", color: TEXT_MUTED, lineHeight: 1.4 }}
        >
          {sub}
        </div>
      ) : null}
    </div>
  );
}
