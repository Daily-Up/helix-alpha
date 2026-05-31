/**
 * Repository — `macro_calendar` and `macro_history`. Wave 2: async.
 */

import { all, batch } from "../client";
import type {
  MacroCalendarDay,
  MacroEventHistoryRow,
} from "@/lib/sosovalue/macro";

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
  const num = Number(stripped);
  return {
    num: Number.isFinite(num) ? num : null,
    unit: isPct ? "%" : null,
  };
}

export async function upsertCalendar(days: MacroCalendarDay[]): Promise<number> {
  if (days.length === 0) return 0;
  const stmts: Array<{ sql: string; args: string[] }> = [];
  const sql = `INSERT INTO macro_calendar (date, event) VALUES (?, ?)
               ON CONFLICT(date, event) DO NOTHING`;
  for (const d of days) {
    for (const ev of d.events) {
      stmts.push({ sql, args: [d.date, ev] });
    }
  }
  if (stmts.length > 0) await batch(stmts);
  return stmts.length;
}

export async function getUpcomingMacroEvents(
  fromDate: string,
  limit = 30,
): Promise<Array<{ date: string; event: string }>> {
  return all<{ date: string; event: string }>(
    `SELECT date, event FROM macro_calendar
     WHERE date >= ?
     ORDER BY date ASC, event ASC
     LIMIT ?`,
    [fromDate, limit],
  );
}

export async function listCalendarEventNames(): Promise<string[]> {
  const rows = await all<{ event: string }>(
    `SELECT DISTINCT event FROM macro_calendar ORDER BY event`,
  );
  return rows.map((r) => r.event);
}

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
  surprise: number | null;
}

export async function upsertEventHistory(
  event: string,
  rows: MacroEventHistoryRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = `INSERT INTO macro_history
     (event, date, actual_raw, forecast_raw, previous_raw,
      actual, forecast, previous, unit, surprise)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(event, date) DO UPDATE SET
     actual_raw   = excluded.actual_raw,
     forecast_raw = excluded.forecast_raw,
     previous_raw = excluded.previous_raw,
     actual       = excluded.actual,
     forecast     = excluded.forecast,
     previous     = excluded.previous,
     unit         = excluded.unit,
     surprise     = excluded.surprise`;

  const stmts = rows.map((r) => {
    const a = parseRawReading(r.actual ?? null);
    const f = parseRawReading(r.forecast ?? null);
    const p = parseRawReading(r.previous ?? null);
    const surprise = a.num != null && f.num != null ? a.num - f.num : null;
    const unit = a.unit ?? f.unit ?? p.unit ?? null;
    return {
      sql,
      args: [
        event,
        r.date,
        r.actual ?? null,
        r.forecast ?? null,
        r.previous ?? null,
        a.num,
        f.num,
        p.num,
        unit,
        surprise,
      ] as (string | number | null)[],
    };
  });
  await batch(stmts);
  return rows.length;
}

export async function listRecentHistory(opts: {
  limit?: number;
  daysBack?: number;
  event?: string;
} = {}): Promise<MacroHistoryRow[]> {
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
  return all<MacroHistoryRow>(
    `SELECT * FROM macro_history
     ${whereSql}
     ORDER BY date DESC, event ASC
     LIMIT ?`,
    params,
  );
}

export async function listRecentSurprises(opts: {
  daysBack?: number;
  limit?: number;
  requireForecast?: boolean;
} = {}): Promise<MacroHistoryRow[]> {
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
  return all<MacroHistoryRow>(
    `SELECT * FROM macro_history
     WHERE ${where.join(" AND ")}
     ORDER BY ABS(surprise) DESC, date DESC
     LIMIT ?`,
    params,
  );
}
