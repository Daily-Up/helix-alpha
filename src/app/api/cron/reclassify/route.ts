/**
 * GET/POST /api/cron/reclassify
 *
 * Re-runs Claude classification on events whose `prompt_version` is older
 * than the current CLASSIFY_PROMPT_VERSION. Used after a prompt schema bump
 * (e.g. when we added actionable + event_recency in v2).
 *
 * Idempotent — safe to run repeatedly. Targets only stale rows.
 *
 * Query: ?limit=N (default 50, max 200)
 *        ?force=1 to re-run regardless of prompt_version
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { classifyBatch, CLASSIFY_PROMPT_VERSION } from "@/lib/ai";
import { db, Cron } from "@/lib/db";
import type { StoredEvent } from "@/lib/db/repos/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface EventRow {
  id: string;
  release_time: number;
  title: string;
  content: string | null;
  author: string | null;
  source_link: string | null;
  original_link: string | null;
  category: number;
  tags: string | null;
  matched_currencies: string | null;
  impression_count: number | null;
  like_count: number | null;
  retweet_count: number | null;
  is_blue_verified: number;
  ingested_at: number;
}

async function handle(req: Request): Promise<NextResponse> {
  try {
    assertCronAuth(req);
  } catch (err) {
    return cronAuthErrorResponse(err);
  }

  const url = new URL(req.url);
  const limit = clamp(numParam(url, "limit") ?? 50, 1, 200);
  const force = url.searchParams.get("force") === "1";
  // Optional: target a single event_id (or comma-separated list). Useful
  // for validating prompt fixes against a known-bad case without paying
  // to reclassify the entire backlog.
  const idsParam = url.searchParams.get("ids");
  const targetIds = idsParam
    ? idsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  interface ReclassifyData {
    processed: number;
    errors: number;
    tokens?: { input: number; output: number; cached: number };
  }
  try {
    const result = await Cron.recordRun<ReclassifyData>("classify_events", async () => {
      // Find events that either (a) have no classification, OR (b) have a
      // classification with an older prompt_version. Or, if `ids` is
      // passed, just process those specific events (and DELETE their
      // existing classifications so the new one writes cleanly).
      let rows: EventRow[];
      if (targetIds && targetIds.length > 0) {
        // Wipe any existing classifications for the targeted ids so the
        // upsert produces a fresh row under the current prompt_version.
        const delStmt = db().prepare(
          "DELETE FROM classifications WHERE event_id = ?",
        );
        for (const id of targetIds) delStmt.run(id);

        const placeholders = targetIds.map(() => "?").join(",");
        rows = db()
          .prepare<string[], EventRow>(
            `SELECT * FROM news_events WHERE id IN (${placeholders})`,
          )
          .all(...targetIds);
      } else if (force) {
        rows = db()
          .prepare<[number], EventRow>(
            `SELECT n.* FROM news_events n
             LEFT JOIN classifications c ON c.event_id = n.id
             ORDER BY n.release_time DESC LIMIT ?`,
          )
          .all(limit);
      } else {
        rows = db()
          .prepare<[string, number], EventRow>(
            `SELECT n.* FROM news_events n
             LEFT JOIN classifications c ON c.event_id = n.id
             WHERE c.event_id IS NULL
                OR c.prompt_version IS NULL
                OR c.prompt_version != ?
             ORDER BY n.release_time DESC LIMIT ?`,
          )
          .all(CLASSIFY_PROMPT_VERSION, limit);
      }

      // Convert raw rows into the StoredEvent shape the classifier expects.
      const targets: StoredEvent[] = rows.map((row) => ({
        id: row.id,
        release_time: row.release_time,
        title: row.title,
        content: row.content,
        author: row.author,
        source_link: row.source_link,
        original_link: row.original_link,
        category: row.category,
        tags: row.tags ? JSON.parse(row.tags) : [],
        matched_currencies: row.matched_currencies
          ? JSON.parse(row.matched_currencies)
          : [],
        impression_count: row.impression_count,
        like_count: row.like_count,
        retweet_count: row.retweet_count,
        is_blue_verified: !!row.is_blue_verified,
        ingested_at: row.ingested_at,
      }));

      if (targets.length === 0) {
        const empty: ReclassifyData = { processed: 0, errors: 0 };
        return {
          summary: `prompt_version=${CLASSIFY_PROMPT_VERSION} all up-to-date`,
          data: empty,
        };
      }

      const { results, errors, totals } = await classifyBatch(targets);
      const text =
        `processed=${results.length} errors=${errors.length} ` +
        `cost=$${(
          (totals.input * 3 + totals.cached * 0.3 + totals.output * 15) /
          1_000_000
        ).toFixed(4)}`;
      const data: ReclassifyData = {
        processed: results.length,
        errors: errors.length,
        tokens: {
          input: totals.input,
          output: totals.output,
          cached: totals.cached,
        },
      };
      return { summary: text, data };
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "reclassify failed" },
      { status: 500 },
    );
  }
}

function numParam(url: URL, key: string): number | undefined {
  const v = url.searchParams.get(key);
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
