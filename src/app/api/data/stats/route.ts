/**
 * GET /api/data/stats
 *
 * High-level numbers for the dashboard top bar:
 *   - total events / classified / unclassified
 *   - last cron run summary
 *   - 24h event count
 *   - top sentiment breakdown
 */

import { NextResponse } from "next/server";
import { db, Events } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const conn = db();
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

  const totalEvents = (
    conn.prepare("SELECT COUNT(*) AS n FROM news_events").get() as {
      n: number;
    }
  ).n;
  const totalClassified = (
    conn.prepare("SELECT COUNT(*) AS n FROM classifications").get() as {
      n: number;
    }
  ).n;
  // "pending" only counts non-duplicate, classifiable events. Duplicates
  // are intentionally never classified (they reuse the canonical event's
  // classification) — including them inflated the displayed backlog.
  const unclassified = Events.countUnclassifiedEvents();
  const events24h = (
    conn
      .prepare<[number], { n: number }>(
        "SELECT COUNT(*) AS n FROM news_events WHERE release_time >= ?",
      )
      .get(dayAgo)
  )!.n;

  const sentimentBreakdown = conn
    .prepare(
      `SELECT c.sentiment AS sentiment, COUNT(*) AS n
       FROM classifications c
       JOIN news_events e ON e.id = c.event_id
       WHERE e.release_time >= ?
       GROUP BY c.sentiment`,
    )
    .all(dayAgo) as Array<{ sentiment: string; n: number }>;

  const eventTypeBreakdown = conn
    .prepare(
      `SELECT c.event_type AS event_type, COUNT(*) AS n
       FROM classifications c
       JOIN news_events e ON e.id = c.event_id
       WHERE e.release_time >= ?
       GROUP BY c.event_type
       ORDER BY n DESC`,
    )
    .all(dayAgo) as Array<{ event_type: string; n: number }>;

  const lastRun = conn
    .prepare(
      `SELECT id, job, started_at, finished_at, status, summary
       FROM cron_runs
       WHERE job = 'ingest_news'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get() as {
    id: number;
    job: string;
    started_at: number;
    finished_at: number | null;
    status: string;
    summary: string | null;
  } | undefined;

  return NextResponse.json({
    total_events: totalEvents,
    total_classified: totalClassified,
    unclassified,
    events_24h: events24h,
    sentiment_breakdown: sentimentBreakdown,
    event_type_breakdown: eventTypeBreakdown,
    last_run: lastRun ?? null,
  });
}
