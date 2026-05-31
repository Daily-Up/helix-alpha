/**
 * GET /api/data/stats — high-level dashboard numbers. Wave 2: async.
 */

import { NextResponse } from "next/server";
import { all, get, Events } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

  const totalEvents =
    (await get<{ n: number }>("SELECT COUNT(*) AS n FROM news_events"))?.n ?? 0;
  const totalClassified =
    (await get<{ n: number }>("SELECT COUNT(*) AS n FROM classifications"))
      ?.n ?? 0;
  const unclassified = await Events.countUnclassifiedEvents();
  const events24h =
    (
      await get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM news_events WHERE release_time >= ?",
        [dayAgo],
      )
    )?.n ?? 0;

  const sentimentBreakdown = await all<{ sentiment: string; n: number }>(
    `SELECT c.sentiment AS sentiment, COUNT(*) AS n
     FROM classifications c
     JOIN news_events e ON e.id = c.event_id
     WHERE e.release_time >= ?
     GROUP BY c.sentiment`,
    [dayAgo],
  );

  const eventTypeBreakdown = await all<{ event_type: string; n: number }>(
    `SELECT c.event_type AS event_type, COUNT(*) AS n
     FROM classifications c
     JOIN news_events e ON e.id = c.event_id
     WHERE e.release_time >= ?
     GROUP BY c.event_type
     ORDER BY n DESC`,
    [dayAgo],
  );

  const lastRun = await get<{
    id: number;
    job: string;
    started_at: number;
    finished_at: number | null;
    status: string;
    summary: string | null;
  }>(
    `SELECT id, job, started_at, finished_at, status, summary
     FROM cron_runs
     WHERE job = 'ingest_news'
     ORDER BY started_at DESC LIMIT 1`,
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
}
