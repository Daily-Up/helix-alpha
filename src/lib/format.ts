/**
 * Formatting helpers for the UI.
 *
 * Keep these tiny and side-effect free so they can be used in both
 * server and client components.
 */

/**
 * Pretty asset-symbol display.
 *
 * SoSoValue's sector-index tickers are lowercase "ssi"-prefixed strings
 * (`ssimag7`, `ssidefi`, `ssilayer1`, …) which read as nonsense in the UI.
 * Convert to the friendly form the user actually recognises:
 *   ssimag7  → MAG7.ssi
 *   ssidefi  → DEFI.ssi
 *   ssilayer1 → LAYER1.ssi
 *
 * Non-index symbols pass through unchanged.
 */
export function fmtAssetSymbol(
  symbol: string | null | undefined,
  kind?: string | null,
): string {
  if (!symbol) return "—";
  if (kind === "index" && symbol.toLowerCase().startsWith("ssi")) {
    const stem = symbol.slice(3).toUpperCase();
    return `${stem}.ssi`;
  }
  return symbol;
}

/**
 * Display price with magnitude-aware precision.
 *
 *   ≥ $1,000  → "$80,868" or "$80,868.55" — commas, ≤ 2 decimals
 *   ≥ $1      → "$150.42"                 — 2 decimals
 *   ≥ $0.01   → "$0.5485"                 — 4 decimals (mid-cap crypto, sub-dollar)
 *   < $0.01   → "$0.000124"               — 6 decimals (memecoins / tiny)
 *
 * Fixes the case where a BTC price was rendering as "$80868.0000"
 * — 4 decimals on a 5-digit-base number is line noise. The leading-zero
 * regime keeps enough precision for sub-dollar assets where the
 * difference between $0.5485 and $0.5490 actually matters.
 */
export function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) {
    return (
      "$" +
      n.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      })
    );
  }
  if (abs >= 1) return "$" + n.toFixed(2);
  if (abs >= 0.01) return "$" + n.toFixed(4);
  return "$" + n.toFixed(6);
}

/**
 * Display-friendly SoDEX trading pair.
 *
 * SoDEX names spot pairs as `vBASE_vQUOTE` (e.g. `vBTC_vUSDC`,
 * `vMAG7ssi_vUSDC`). The leading `v` is a SoDEX internal convention
 * users don't recognise. We strip it on display and switch the
 * underscore to a slash so the symbol reads like a real exchange pair:
 *   vBTC_vUSDC      → BTC/USDC
 *   vMAG7ssi_vUSDC  → MAG7ssi/USDC
 *
 * Perp markets (`BASE-USD`, e.g. `COIN-USD`) are already user-readable
 * and pass through unchanged.
 *
 * The raw `sodex_symbol` field continues to be the authoritative
 * identifier in logic, the DB, and API requests — this is a UI shim.
 */
export function fmtSodexSymbol(s: string | null | undefined): string {
  if (!s) return "—";
  if (s.includes("-USD")) return s; // perp — leave alone
  if (!s.includes("_")) return s; // unknown shape — defensive
  return s
    .split("_")
    .map((part) => part.replace(/^v(?=[A-Z0-9])/, ""))
    .join("/");
}

/** "$1.23B", "$45.6M", "$789K", "$12.34". */
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

/** "+1.23%", "-4.56%", "0.00%". */
export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

/** Convert a fraction (0.025) to a percent string (+2.50%). */
export function fmtFracPct(
  n: number | null | undefined,
  digits = 2,
): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return fmtPct(n * 100, digits);
}

/** "12s", "4m", "2h", "3d" — relative time from a millisecond ts. */
export function fmtRelative(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * "in 12s" / "in 4m" / "in 2h" / "in 3d" — future-relative time. Returns
 * "expired" when the timestamp is in the past. Mirror of `fmtRelative`
 * for forward-looking deadlines (signal expiry, rebalance schedule, etc.).
 */
export function fmtUntil(ts: number, now: number = Date.now()): string {
  const diff = ts - now;
  if (diff <= 0) return "expired";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    const remMin = min % 60;
    return remMin > 0 ? `in ${hr}h ${remMin}m` : `in ${hr}h`;
  }
  const day = Math.floor(hr / 24);
  if (day < 30) return `in ${day}d`;
  return new Date(ts).toISOString().slice(0, 10);
}

/** "16:30" — UTC HH:MM from a ms timestamp. */
export function fmtTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 16);
}

/** "Tue 16:30" — short weekday + time, useful for the event feed. */
export function fmtShortDateTime(ts: number): string {
  const d = new Date(ts);
  const day = d.toUTCString().slice(0, 3);
  return `${day} ${d.toISOString().slice(11, 16)}`;
}

/** Truncate a string to N chars with an ellipsis. */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

/** Big-O number formatter — "1.2k", "45.7M". */
export function fmtCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(1)}k`;
  return String(n);
}
