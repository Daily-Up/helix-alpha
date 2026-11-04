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
      skipped24h,
      duplicates24h,
      events24h,
      sentimentBreakdown,
      eventTypeBreakdown,
      lastRun,
      lastIngestMs,
    ] = await Promise.all([
      guard(countQuery("SELECT COUNT(*) AS n FROM news_events"), 0),
      guard(countQuery("SELECT COUNT(*) AS n FROM classifications"), 0),
      // 24h counts via indexes (idx_skipped_pre_classify_at / idx_news_release_time)
      // — reliably fast, unlike a full-table scan that can spike past the guard.
      guard(
        countQuery(
          "SELECT COUNT(*) AS n FROM skipped_pre_classify WHERE skipped_at >= ?",
          [dayAgo],
        ),
        0,
      ),
      guard(
        countQuery(
          "SELECT COUNT(*) AS n FROM news_events WHERE release_time >= ? AND duplicate_of IS NOT NULL",
          [dayAgo],
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
      // The TRUE "last ingest" — when we last stored any event. The cron_runs
      // record above tracks the NAMED GitHub Actions cron, which can sit stale
      // for hours while the live pipeline (/api/public/run-tick, triggered on
      // page visits) keeps ingesting — so cron_runs said "21h ago" while the
      // newest event was minutes old. MAX(ingested_at) reflects reality.
      guard(countQuery("SELECT MAX(ingested_at) AS n FROM news_events"), 0),
    ]);

    // Pending = last-24h classification backlog: events in the window that
    // aren't yet classified, pre-skipped, or duplicates. All three counts are
    // index-backed 24h queries (fast + reliable), so pending never inflates
    // from a timed-out full-table scan. classified_24h = Σ sentiment buckets.
    const classified24h = sentimentBreakdown.reduce((s, r) => s + r.n, 0);
    const unclassified = Math.max(
      0,
      events24h - classified24h - skipped24h - duplicates24h,
    );

    return NextResponse.json({
      total_events: totalEvents,
      total_classified: totalClassified,
      unclassified,
      events_24h: events24h,
      sentiment_breakdown: sentimentBreakdown,
      event_type_breakdown: eventTypeBreakdown,
      last_run: lastRun ?? null,
      // Freshness signal for the UI (real last ingest, not the named cron).
      last_ingest_ms: lastIngestMs || null,
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
        last_ingest_ms: null,
        error: (err as Error).message ?? "stats query failed",
      },
      { status: 200 },
    );
  }
}
