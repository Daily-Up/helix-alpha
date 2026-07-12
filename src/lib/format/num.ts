/**
 * The ONE number-formatting policy for the whole app. Precision is a
 * design decision by magnitude class — never an API passthrough.
 *
 *   >= 1e9   → 2dp + "B"     (106.77B)
 *   >= 1e6   → 1dp + "M"     (328.4M)
 *   >= 1e3   → thousands-sep, integer-ish  (64,197)   [compact→ "9.5K"]
 *   1..1000  → 2dp           (289.82, 5.39)
 *   0<a<1    → up to 4 significant decimals, trimmed  (0.6695, 0.0067)
 *   0        → "0"  (caller mutes — zero recedes)
 *   null/NaN → EMPTY (caller renders <Empty/>)
 *
 * `title` always carries full precision for hover/click.
 */

export const EMPTY_GLYPH = "—";

export interface NumFmtOpts {
  /** "$" prefix, "%" suffix, or a unit suffix like "USDC". */
  unit?: string;
  /** Force a leading "+" on positives. */
  sign?: boolean;
  /** Override decimal places for the 1..1000 band. */
  dp?: number;
  /** Use K/M/B compaction in the thousands band too (9.5K). */
  compact?: boolean;
}

export interface NumParts {
  text: string;
  /** Full-precision string for the title attribute. */
  title: string;
  isZero: boolean;
  isEmpty: boolean;
  isNegative: boolean;
}

function trimSubOne(v: number): string {
  // up to 4 decimals, trailing zeros trimmed; never scientific soup.
  let s = v.toFixed(4);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

export function formatNum(
  value: number | null | undefined,
  opts: NumFmtOpts = {},
): NumParts {
  if (value == null || Number.isNaN(value)) {
    return { text: EMPTY_GLYPH, title: EMPTY_GLYPH, isZero: false, isEmpty: true, isNegative: false };
  }
  const neg = value < 0;
  const a = Math.abs(value);
  const title = String(value);

  let body: string;
  if (a === 0) {
    body = opts.dp != null ? (0).toFixed(opts.dp) : "0";
  } else if (a >= 1e9) {
    body = (a / 1e9).toFixed(2) + "B";
  } else if (a >= 1e6) {
    body = (a / 1e6).toFixed(1) + "M";
  } else if (a >= 1e3) {
    body = opts.compact
      ? (a / 1e3).toFixed(1) + "K"
      : Math.round(a).toLocaleString("en-US");
  } else if (a >= 1) {
    body = a.toFixed(opts.dp ?? 2);
  } else {
    // Honour an explicit dp even sub-1 (e.g. a 0.9% drift shows "0.9%",
    // not "0.9027%"); otherwise cap at 4 significant decimals.
    body = opts.dp != null ? a.toFixed(opts.dp) : trimSubOne(a);
  }

  const signStr = neg ? "-" : opts.sign && value > 0 ? "+" : "";
  const unit = opts.unit ?? "";
  let text: string;
  if (unit === "$") text = `${signStr}$${body}`;
  else if (unit === "%") text = `${signStr}${body}%`;
  else if (unit) text = `${signStr}${body} ${unit}`;
  else text = `${signStr}${body}`;

  return { text, title, isZero: value === 0, isEmpty: false, isNegative: neg };
}
