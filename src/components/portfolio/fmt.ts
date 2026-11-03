/**
 * Portfolio number formatting — matches the trade terminal's conventions:
 * dollars always 2-dec with a sub-cent floor, signed values with the sign
 * before the currency symbol, percentages with an explicit +/−. Compact
 * magnitudes ($1.2K / $3.4M) reuse @/lib/format's fmtUsd.
 */

export { fmtUsd as compactUsd } from "@/lib/format";

/** "$1,234.50" / "—"; a non-zero magnitude under a cent → "<$0.01". */
export function money(v: number | null | undefined, d = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (d <= 2 && v > 0 && v < 0.01) return "<$0.01";
  return `$${v.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })}`;
}

/** "+$12.34" / "−$5.00" / "—"; sub-cent magnitude keeps its sign ("+<$0.01"). */
export function signedMoney(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v < 0 ? "−" : "+";
  const abs = Math.abs(v);
  if (abs > 0 && abs < 0.01) return `${sign}<$0.01`;
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** "+1.23%" / "−4.56%" / "—". */
export function signedPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v >= 0 ? "+" : "−";
  return `${sign}${Math.abs(v).toFixed(digits)}%`;
}

/** A price trimmed to its tick precision (trailing zeros + dangling dot gone):
 *  71,000.0000 → 71,000; 1,080.6200 → 1,080.62. Matches BottomPanel.fmtPrice. */
export function fmtPrice(
  value: number | null | undefined,
  tick?: number,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const dp =
    !tick || !Number.isFinite(tick) || tick <= 0
      ? 2
      : tick >= 1
        ? 0
        : Math.min(8, Math.ceil(-Math.log10(tick)));
  let s = value.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/** Local date like "Nov 3, 2026" — for the "History starts <date>" note. */
export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
