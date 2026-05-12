/**
 * Macro ingest.
 *
 *   1. Pull /macro/events → upsert calendar (date, event_name) rows
 *   2. For each unique event name → /macro/events/{name}/history
 *      → parse strings ("0.9%") into numeric + unit + surprise, upsert
 *
 * Idempotent on (event, date). Recommended schedule: once per day —
 * macro prints don't change after release, and the API only returns
 * the most recent 50 readings per indicator anyway.
 *
 * The /history endpoint requires the FULL event name as it appears on
 * the calendar (e.g. "CPI (MoM)") — short forms like "CPI" return [].
 */

import { Cron, Macro } from "@/lib/db";
import { Macro as MacroAPI } from "@/lib/sosovalue";

export interface MacroIngestSummary {
  calendar_days: number;
  calendar_events_upserted: number;
  events_with_history: number;
  history_events_processed: number;
  history_rows_upserted: number;
  history_failures: number;
  errors: Array<{ event: string; error: string }>;
  latency_ms: number;
}

export interface MacroIngestOptions {
  /** Throttle between per-event /history calls. Default 600ms. */
  delayMs?: number;
  /** Skip the calendar pull (only refresh history). */
  skipCalendar?: boolean;
  /** Limit which events get history fetched (test mode). */
  onlyEvents?: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runMacroIngest(
  opts: MacroIngestOptions = {},
): Promise<MacroIngestSummary> {
  const t0 = Date.now();
  const delayMs = opts.delayMs ?? 600;

  let calendarDays = 0;
  let calendarEventsUpserted = 0;

  // ── 1. Calendar ────────────────────────────────────────────────
  if (!opts.skipCalendar) {
    const days = await MacroAPI.getMacroCalendar();
    calendarDays = days.length;
    calendarEventsUpserted = Macro.upsertCalendar(days);
  }

  // ── 2. History per unique event name ──────────────────────────
  const allNames = Macro.listCalendarEventNames();
  const targets = opts.onlyEvents
    ? allNames.filter((n) => opts.onlyEvents!.includes(n))
    : allNames;

  let historyRowsUpserted = 0;
  let historyEventsProcessed = 0;
  let historyEventsWithData = 0;
  let historyFailures = 0;
  const errors: MacroIngestSummary["errors"] = [];

  for (const event of targets) {
    try {
      const rows = await MacroAPI.getMacroEventHistory(event, { limit: 50 });
      historyEventsProcessed++;
      if (rows.length > 0) {
        historyEventsWithData++;
        historyRowsUpserted += Macro.upsertEventHistory(event, rows);
      }
    } catch (err) {
      historyFailures++;
      errors.push({
        event,
        error: (err as Error).message ?? String(err),
      });
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    calendar_days: calendarDays,
    calendar_events_upserted: calendarEventsUpserted,
    events_with_history: historyEventsWithData,
    history_events_processed: historyEventsProcessed,
    history_rows_upserted: historyRowsUpserted,
    history_failures: historyFailures,
    errors,
    latency_ms: Date.now() - t0,
  };
}

export async function runMacroIngestWithAudit(
  opts: MacroIngestOptions = {},
): Promise<MacroIngestSummary & { run_id: number }> {
  const { id, data } = await Cron.recordRun("ingest_macro", async () => {
    const summary = await runMacroIngest(opts);
    const text =
      `cal_days=${summary.calendar_days} ` +
      `cal_events=${summary.calendar_events_upserted} ` +
      `hist_events=${summary.history_events_processed} ` +
      `hist_with_data=${summary.events_with_history} ` +
      `hist_rows=${summary.history_rows_upserted} ` +
      `failures=${summary.history_failures} ` +
      `latency=${(summary.latency_ms / 1000).toFixed(1)}s`;
    return { summary: text, data: summary };
  });
  return { ...(data as MacroIngestSummary), run_id: id };
}
