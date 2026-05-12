/**
 * Repository — `macro_calendar` and `macro_history`.
 *
 * macro_history stores both the API's string-with-unit form (so we can
 * display "0.9%" verbatim) and a parsed numeric form (so we can compute
 * surprise = actual - forecast). The two-column setup is on purpose —
 * stripping units at ingest is a one-way operation we don't want to
 * lose context on.
 */

import { db } from "../client";
import type {
  MacroCalendarDay,
  MacroEventHistoryRow,
} from "@/lib/sosovalue/macro";

/**
 * Parse a raw API value like "0.9%" / "54.5" / "3980000.0" / "-0.1%"
 * into { num, unit }. Returns null num when the string is missing or
 * unparseable. Unit is "%" for percentage strings, otherwise null.
 */
export function parseRawReading(raw: string | null | undefined): {
  num: number | null;
  unit: string | null;
} {
  if (raw == null) return { num: null, unit: null };
  const trimmed = raw.toString().trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "—") {
    return { num: null, unit: null };
  }
  const isPct = trimmed.endsWith("%");
  const stripped = isPct ? trimmed.slice(0, -1) : trimmed;
  // The API also occasionally suffixes K/M/B but for the indicators we
  // see today (CPI, PPI, Retail Sales, PMI, Existing Home Sales) values
  // are plain numbers or %. Extend here if we see scaled units.
  const num = Number(stripped);
  return {
    num: Number.isFinite(num) ? num : null,
    unit: isPct ? "%" : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Calendar
// ─────────────────────────────────────────────────────────────────────────

/** Replace today's calendar with the latest from /macro/events. */
export function upsertCalendar(days: MacroCalendarDay[]): number {
  if (days.length === 0) return 0;
  const stmt = db().prepare(
    `INSERT INTO macro_calendar (date, event) VALUES (?, ?)
     ON CONFLICT(date, event) DO NOTHING`,
  );
  const tx = db().transaction((items: MacroCalendarDay[]) => {
    let n = 0;
    for (const d of items)
      for (const ev of d.events) {
        stmt.run(d.date, ev);
        n++;
      }
    return n;
  });
  return tx(days);
}

export function getUpcomingMacroEvents(
  fromDate: string,
  limit = 30,
): Array<{ date: string; event: string }> {
  return db()
    .prepare<[string, number], { date: string; event: string }>(
      `SELECT date, event FROM macro_calendar
       WHERE date >= ?
       ORDER BY date ASC, event ASC
       LIMIT ?`,
    )
    .all(fromDate, limit);
}

/** All distinct event names ever seen on the calendar — used by the
 *  ingest job to drive per-event /history fetches. */
export function listCalendarEventNames(): string[] {
  return db()
    .prepare<[], { event: string }>(
      `SELECT DISTINCT event FROM macro_calendar ORDER BY event`,
    )
    .all()
    .map((r) => r.event);
}

// ─────────────────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────────────────

export interface MacroHistoryRow {
  event: string;
  date: string;
  actual_raw: string | null;
  forecast_raw: string | null;
  previous_raw: string | null;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  unit: string | null;
  /** actual - forecast (numeric). NULL when either side missing. */
  surprise: number | null;
}

/** Upsert a batch of history rows for one event.
 *  Parses each raw reading into numeric + unit, and computes surprise. */
export function upsertEventHistory(
  event: string,
  rows: MacroEventHistoryRow[],
): number {
  if (rows.length === 0) return 0;
  const stmt = db().prepare(
    `INSERT INTO macro_history
       (event, date, actual_raw, forecast_raw, previous_raw,
        actual, forecast, previous, unit, surprise)
     VALUES (@event, @date, @actual_raw, @forecast_raw, @previous_raw,
             @actual, @forecast, @previous, @unit, @surprise)
     ON CONFLICT(event, date) DO UPDATE SET
       actual_raw   = excluded.actual_raw,
       forecast_raw = excluded.forecast_raw,
       previous_raw = excluded.previous_raw,
       actual       = excluded.actual,
       forecast     = excluded.forecast,
       previous     = excluded.previous,
       unit         = excluded.unit,
       surprise     = excluded.surprise`,
  );
  const tx = db().transaction((items: MacroEventHistoryRow[]) => {
    let n = 0;
    for (const r of items) {
      const a = parseRawReading(r.actual ?? null);
      const f = parseRawReading(r.forecast ?? null);
      const p = parseRawReading(r.previous ?? null);
      const surprise =
        a.num != null && f.num != null ? a.num - f.num : null;
      // Prefer actual's unit, fall back to forecast's. They should match.
      const unit = a.unit ?? f.unit ?? p.unit ?? null;
      stmt.run({
        event,
        date: r.date,
        actual_raw: r.actual ?? null,
        forecast_raw: r.forecast ?? null,
        previous_raw: r.previous ?? null,
        actual: a.num,
        forecast: f.num,
        previous: p.num,
        unit,
        surprise,
      });
      n++;
    }
    return n;
  });
  return tx(rows);
}

/** Recent macro history rows, newest first. */
export function listRecentHistory(opts: {
  limit?: number;
  daysBack?: number;
  event?: string;
} = {}): MacroHistoryRow[] {
  const limit = opts.limit ?? 50;
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (opts.daysBack != null) {
    const cutoff = new Date(Date.now() - opts.daysBack * 86400 * 1000)
      .toISOString()
      .slice(0, 10);
    where.push("date >= ?");
    params.push(cutoff);
  }
  if (opts.event) {
    where.push("event = ?");
    params.push(opts.event);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);
  return db()
    .prepare<typeof params, MacroHistoryRow>(
      `SELECT * FROM macro_history
       ${whereSql}
       ORDER BY date DESC, event ASC
       LIMIT ?`,
    )
    .all(...params);
}

/** "Top surprises" — rows in the window with the largest abs(surprise). */
export function listRecentSurprises(opts: {
  daysBack?: number;
  limit?: number;
  /** Only keep rows where forecast was provided (skip prints with no
   *  consensus, e.g. some PMIs). */
  requireForecast?: boolean;
} = {}): MacroHistoryRow[] {
  const limit = opts.limit ?? 10;
  const days = opts.daysBack ?? 60;
  const cutoff = new Date(Date.now() - days * 86400 * 1000)
    .toISOString()
    .slice(0, 10);
  const where = ["date >= ?", "surprise IS NOT NULL"];
  const params: Array<string | number> = [cutoff];
  if (opts.requireForecast) {
    where.push("forecast IS NOT NULL");
  }
  params.push(limit);
  return db()
    .prepare<typeof params, MacroHistoryRow>(
      `SELECT * FROM macro_history
       WHERE ${where.join(" AND ")}
       ORDER BY ABS(surprise) DESC, date DESC
       LIMIT ?`,
    )
    .all(...params);
}
