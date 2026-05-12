/**
 * HeroStat — one headline number per dashboard page.
 *
 * Editorial dashboard hierarchy (Path B): each dashboard promotes
 * a single most-important metric to large Fraunces type, with the
 * change/sub indicator in JetBrains Mono beneath. Everything else
 * on the page is supporting evidence at lower visual weight.
 *
 * Styles are inlined as React style objects rather than CSS classes
 * because Turbopack's CSS HMR on Windows has been unreliable —
 * inlining guarantees the styling lands regardless of bundle state.
 */

import { cn } from "./cn";

const TEXT_BRAND = "#ede4d3";
const TEXT_MUTED = "#8a857a";
const BORDER_QUIET = "rgba(237, 228, 211, 0.08)";

interface HeroStatProps {
  label: string;
  value: string;
  /** Optional change indicator below the value, e.g. "+5.61% · $561". */
  change?: string;
  changeTone?: "positive" | "negative" | "neutral";
  /** Optional supplementary line below the change, plain prose. */
  sub?: string;
  className?: string;
}

export function HeroStat({
  label,
  value,
  change,
  changeTone = "neutral",
  sub,
  className,
}: HeroStatProps) {
  const changeColor =
    changeTone === "positive"
      ? "#5cc97a"
      : changeTone === "negative"
        ? "#e06c66"
        : TEXT_BRAND;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div
        className="font-[var(--font-jetbrains-mono)] uppercase"
        style={{
          fontSize: "11px",
          fontWeight: 500,
          letterSpacing: "0.12em",
          color: TEXT_MUTED,
        }}
      >
        {label}
      </div>
      <div
        className="font-[var(--font-fraunces)] tabular-nums"
        style={{
          fontSize: "clamp(48px, 6vw, 88px)",
          fontWeight: 300,
          letterSpacing: "-0.025em",
          lineHeight: 1.0,
          color: TEXT_BRAND,
        }}
      >
        {value}
      </div>
      {change ? (
        <div
          className="font-[var(--font-jetbrains-mono)] tabular-nums"
          style={{
            fontSize: "15px",
            letterSpacing: "0.02em",
            color: changeColor,
          }}
        >
          {change}
        </div>
      ) : null}
      {sub ? (
        <div
          className="font-[var(--font-inter)]"
          style={{ fontSize: "13px", color: TEXT_MUTED }}
        >
          {sub}
        </div>
      ) : null}
    </div>
  );
}

interface SubStatProps {
  label: string;
  value: string;
  sub?: string;
  tone?: "positive" | "negative" | "neutral";
  className?: string;
}

/**
 * SubStat — supporting stat row. Used after the hero, with
 * reduced visual weight relative to the legacy Stat card.
 */
export function SubStat({
  label,
  value,
  sub,
  tone = "neutral",
  className,
}: SubStatProps) {
  const valueColor =
    tone === "positive"
      ? "#5cc97a"
      : tone === "negative"
        ? "#e06c66"
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
          letterSpacing: "0.1em",
          color: TEXT_MUTED,
        }}
      >
        {label}
      </div>
      <div
        className="font-[var(--font-jetbrains-mono)] tabular-nums"
        style={{
          fontSize: "18px",
          color: valueColor,
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      {sub ? (
        <div
          className="font-[var(--font-inter)]"
          style={{ fontSize: "11px", color: TEXT_MUTED }}
        >
          {sub}
        </div>
      ) : null}
    </div>
  );
}
