"use client";

/**
 * RingGauge — margin-usage ring for the Overview card. An SVG donut whose arc
 * fills with the used-collateral percentage and colours green → amber → red on
 * the same thresholds as the terminal's AccountPanel (comfortable < 50 <
 * caution < 80 < danger). Center shows the percentage; an optional caption sits
 * beneath.
 */

export function ringColor(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return "#5f6b7a";
  if (pct < 50) return "#0ecb81";
  if (pct < 80) return "#e0a53f";
  return "#f6465d";
}

export function RingGauge({
  value,
  size = 112,
  stroke = 9,
  label,
}: {
  /** 0–100 (clamped); null renders an empty, muted ring. */
  value: number | null;
  size?: number;
  stroke?: number;
  label?: string;
}) {
  const pct =
    value == null || !Number.isFinite(value)
      ? null
      : Math.max(0, Math.min(100, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = pct == null ? 0 : (pct / 100) * c;
  const color = ringColor(pct);

  return (
    <div className="flex flex-col items-center" style={{ width: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--line)"
          strokeWidth={stroke}
        />
        {pct != null ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c - dash}`}
            style={{ transition: "stroke-dasharray 400ms ease-out, stroke 300ms" }}
          />
        ) : null}
      </svg>
      <div
        className="pointer-events-none -mt-[calc(50%+14px)] flex flex-col items-center"
        style={{ height: size / 2 }}
      >
        <span
          className="font-[var(--font-jetbrains-mono)] text-[20px] font-semibold leading-none tabular-nums"
          style={{ color }}
        >
          {pct != null ? `${pct.toFixed(0)}%` : "—"}
        </span>
        {label ? (
          <span className="mt-1 text-[9px] uppercase tracking-wider text-fg-dim">
            {label}
          </span>
        ) : null}
      </div>
    </div>
  );
}
