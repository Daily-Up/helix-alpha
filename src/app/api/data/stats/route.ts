/**
 * GET /api/data/stats — high-level dashboard numbers for the Event Stream.
 *
 * Hardened after a prod incident: the old route ran ~7 queries SEQUENTIALLY,
 * one of which — a triple LEFT JOIN counting unclassified events across
 * news_events × classifications × skipped_pre_classify — degraded into a
 * multi-minute scan as the tables grew (41k events), timing the whole
 * function out (504 FUNCTION_INVOCATION_TIMEOUT) and leaving the header
 * stat tiles stuck on "—".
 *
 * Now: every query runs in PARALLEL, each wrapped in a timeout guard so a
 * single slow query can never stall the response, the whole thing is
 * try/caught to always return 200, and "pending" is derived from cheap
 * COUNTs instead of the pathological anti-join.
 */

import { NextResponse } from "next/server";
import { all, get } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/** Resolve to `fallback` if the query errors OR exceeds `ms` (dangling query
 *  is abandoned — the response already returned). */
async function guard<T>(p: Promise<T>, fallback: T, ms = 6000): Promise<T> {
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
  } catch {
    return fallback;
  }
}

function countQuery(sql: string, args: (string | number)[] = []): Promise<number> {
  return get<{ n: number }>(sql, args).then((r) => r?.n ?? 0);
}

export async function GET() {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

  try {
    const [
      totalEvents,
      totalClassified,
      skipped,
      duplicates,
      events24h,
      sentimentBreakdown,
      eventTypeBreakdown,
      lastRun,
    ] = await Promise.all([
      guard(countQuery("SELECT COUNT(*) AS n FROM news_events"), 0),
      guard(countQuery("SELECT COUNT(*) AS n FROM classifications"), 0),
      guard(countQuery("SELECT COUNT(*) AS n FROM skipped_pre_classify"), 0),
      guard(
        countQuery(
          "SELECT COUNT(*) AS n FROM news_events WHERE duplicate_of IS NOT NULL",
        ),
        0,
      ),
      guard(
        countQuery(
          "SELECT COUNT(*) AS n FROM news_events WHERE release_time >= ?",
          [dayAgo],
        ),
        0,
      ),
      guard(
        all<{ sentiment: string; n: number }>(
          `SELECT c.sentiment AS sentiment, COUNT(*) AS n
           FROM classifications c
           JOIN news_events e ON e.id = c.event_id
           WHERE e.release_time >= ?
           GROUP BY c.sentiment`,
          [dayAgo],
        ),
        [] as Array<{ sentiment: string; n: number }>,
      ),
      guard(
        all<{ event_type: string; n: number }>(
          `SELECT c.event_type AS event_type, COUNT(*) AS n
           FROM classifications c
           JOIN news_events e ON e.id = c.event_id
           WHERE e.release_time >= ?
           GROUP BY c.event_type
           ORDER BY n DESC`,
          [dayAgo],
        ),
        [] as Array<{ event_type: string; n: number }>,
      ),
      guard(
        get<{
          started_at: number;
          finished_at: number | null;
          status: string;
          summary: string | null;
        }>(
          `SELECT started_at, finished_at, status, summary
           FROM cron_runs
           WHERE job = 'ingest_news'
           ORDER BY started_at DESC LIMIT 1`,
        ),
        undefined,
      ),
    ]);

    // Pending ≈ everything that isn't classified, skipped, or a duplicate.
    // Cheap subtraction instead of a multi-table anti-join. Approximate at
    // the margins (category overlap), which is fine for a throughput tile.
    const unclassified = Math.max(
      0,
      totalEvents - totalClassified - skipped - duplicates,
    );

    return NextResponse.json({
      total_events: totalEvents,
      total_classified: totalClassified,
      unclassified,
      events_24h: events24h,
      sentiment_breakdown: sentimentBreakdown,
      event_type_breakdown: eventTypeBreakdown,
      last_run: lastRun ?? null,
    });
  } catch (err) {
    // Never 504 the header — return an empty-but-valid shape so the UI
    // renders zeros rather than getting stuck on "—".
    return NextResponse.json(
      {
        total_events: 0,
        total_classified: 0,
        unclassified: 0,
        events_24h: 0,
        sentiment_breakdown: [],
        event_type_breakdown: [],
        last_run: null,
        error: (err as Error).message ?? "stats query failed",
      },
      { status: 200 },
    );
  }
}
