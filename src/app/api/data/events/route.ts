/**
 * GET /api/data/events
 *
 * Returns recent events with their classification joined in. Used by the
 * dashboard's event feed.
 *
 * Query params:
 *   ?limit=100
 *   ?event_type=exploit
 *   ?sentiment=negative
 *   ?severity=high
 *   ?asset_id=tok-btc
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface JoinedRow {
  id: string;
  release_time: number;
  title: string;
  author: string | null;
  source_link: string | null;
  matched_currencies: string | null;
  event_type: string | null;
  sentiment: "positive" | "negative" | "neutral" | null;
  severity: "high" | "medium" | "low" | null;
  confidence: number | null;
  affected_asset_ids: string | null;
  reasoning: string | null;
  // Skipped-pre-classify join — present when the event was gated out
  // before reaching Claude (corpus shape mismatch OR backlog sweep).
  skip_reasoning: string | null;
  skip_score: number | null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = clamp(numParam(url, "limit") ?? 100, 1, 500);
  const eventType = url.searchParams.get("event_type");
  const sentiment = url.searchParams.get("sentiment");
  const severity = url.searchParams.get("severity");
  const assetId = url.searchParams.get("asset_id");

  // Duplicates live in news_events for forensics but are NEVER shown in
  // the consumer feed — by design, the canonical sibling represents the
  // story.
  //
  // Events dropped by the corpus pre-classify gate or backlog sweep
  // also stay out of the consumer feed: from the user's POV they're
  // "the system decided not to classify this" — exposing them creates
  // noise. They remain queryable via `/api/data/skipped` (audit only).
  const wheres: string[] = [
    "n.duplicate_of IS NULL",
    "s.id IS NULL",
  ];
  const params: Array<string | number> = [];

  if (eventType) {
    wheres.push("c.event_type = ?");
    params.push(eventType);
  }
  if (sentiment) {
    wheres.push("c.sentiment = ?");
    params.push(sentiment);
  }
  if (severity) {
    wheres.push("c.severity = ?");
    params.push(severity);
  }

  let sql = `
    SELECT
      n.id,
      n.release_time,
      n.title,
      n.author,
      n.source_link,
      n.matched_currencies,
      c.event_type,
      c.sentiment,
      c.severity,
      c.confidence,
      c.affected_asset_ids,
      c.reasoning,
      s.reasoning AS skip_reasoning,
      s.corpus_score AS skip_score
    FROM news_events n
    LEFT JOIN classifications c ON c.event_id = n.id
    LEFT JOIN skipped_pre_classify s ON s.id = n.id
  `;

  if (assetId) {
    sql += ` JOIN event_assets ea ON ea.event_id = n.id AND ea.asset_id = ?`;
    params.push(assetId);
  }

  if (wheres.length > 0) sql += ` WHERE ${wheres.join(" AND ")}`;
  sql += ` ORDER BY n.release_time DESC LIMIT ?`;
  params.push(limit);

  const rows = db()
    .prepare<typeof params, JoinedRow>(sql)
    .all(...params);

  const events = rows.map((r) => ({
    id: r.id,
    release_time: r.release_time,
    title: r.title,
    author: r.author,
    source_link: r.source_link,
    matched_currencies: r.matched_currencies
      ? (
          JSON.parse(r.matched_currencies) as Array<{ symbol: string }>
        ).map((c) => ({ symbol: c.symbol }))
      : [],
    event_type: r.event_type,
    sentiment: r.sentiment,
    severity: r.severity,
    confidence: r.confidence,
    affected_asset_ids: r.affected_asset_ids
      ? (JSON.parse(r.affected_asset_ids) as string[])
      : [],
    reasoning: r.reasoning,
    // Skip metadata — when set, the event was gated out before Claude.
    // The card renders these differently from genuinely-pending events.
    skip_reasoning: r.skip_reasoning,
    skip_score: r.skip_score,
  }));

  return NextResponse.json({ events });
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
