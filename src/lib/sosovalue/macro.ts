/**
 * SoSoValue Macro endpoints (8.x).
 *
 *   GET /macro/events
 *     Returns the macro calendar grouped by date. Shape:
 *       [{ date: "2026-05-11", events: ["CPI (MoM)", "CPI (YoY)", ...] }, ...]
 *
 *   GET /macro/events/{event}/history
 *     Returns up to 50 historical readings for a single indicator.
 *     The `event` path segment must be the FULL event name shown on the
 *     calendar — e.g. "CPI (MoM)", "S&P Global US Manufacturing PMI".
 *     Short forms ("CPI", "FOMC", "NFP") return empty arrays.
 *
 *     Shape: [{ date, actual, forecast, previous }] — verified live via
 *     scripts/inspect-macro-history.ts.
 *
 * IMPORTANT: actual/forecast/previous come back as STRINGS with units
 * baked in: "0.9%", "54.5", "3980000.0", "-0.1%". The previously-typed
 * `number | null` was wrong — coercing here would silently drop the
 * unit. Parse at the ingest site, not at the wire.
 */

import { sosoGet } from "./client";

/** One day on the macro calendar.
 *  /macro/events returns these grouped by UTC date. */
export interface MacroCalendarDay {
  /** YYYY-MM-DD. */
  date: string;
  /** Full event names occurring that day, e.g. ["CPI (MoM)", "FOMC Rate Decision"]. */
  events: string[];
}

/** One historical reading of a macro indicator.
 *  Field strings include units verbatim: "0.9%", "54.5", "3980000.0". */
export interface MacroEventHistoryRow {
  /** YYYY-MM-DD when the print occurred. */
  date: string;
  /** Reported reading. May be missing for cancelled prints. */
  actual?: string | null;
  /** Consensus forecast. May be missing on indicators that aren't surveyed. */
  forecast?: string | null;
  /** Prior reading (for QoQ comparison). */
  previous?: string | null;
  [key: string]: unknown;
}

/** GET /macro/events — calendar of upcoming + recent macro events. */
export function getMacroCalendar(): Promise<MacroCalendarDay[]> {
  return sosoGet<MacroCalendarDay[]>("/macro/events");
}

/** GET /macro/events/{event}/history — actuals/forecasts for one indicator.
 *
 *  `event` must be the FULL event name as returned by getMacroCalendar
 *  (e.g. "CPI (MoM)"), not an abbreviation.
 */
export function getMacroEventHistory(
  event: string,
  query?: {
    start_date?: string; // YYYY-MM-DD
    end_date?: string;
    limit?: number; // default 50, max 100
  },
): Promise<MacroEventHistoryRow[]> {
  return sosoGet<MacroEventHistoryRow[]>(
    `/macro/events/${encodeURIComponent(event)}/history`,
    { query },
  );
}
