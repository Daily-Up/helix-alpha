/**
 * GET /api/data/signals
 *
 * Returns signals for the /signals page, joined with event title and
 * asset display info so the UI can render without extra lookups.
 *
 * Query: ?status=pending|executed|dismissed  ?tier=auto|review|info  ?limit=N
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface JoinedSignal {
  id: string;
  fired_at: number;
  triggered_by_event_id: string | null;
  asset_id: string;
  sodex_symbol: string;
  direction: "long" | "short";
  tier: "auto" | "review" | "info";
  status: "pending" | "executed" | "dismissed" | "expired";
  confidence: number;
  expected_horizon: string | null;
  suggested_size_usd: number | null;
  suggested_stop_pct: number | null;
  suggested_target_pct: number | null;
  reasoning: string;
  secondary_asset_ids: string | null;
  // ── Pipeline metadata (NULL on legacy rows pre-pipeline-wiring) ──
  catalyst_subtype: string | null;
  expires_at: number | null;
  corroboration_deadline: number | null;
  event_chain_id: string | null;
  asset_relevance: number | null;
  promotional_score: number | null;
  source_tier: number | null;
  dismiss_reason: string | null;
  executed_at: number | null;
  dismissed_at: number | null;
  paper_trade_id: string | null;
  // joined
  event_title: string | null;
  event_release_time: number | null;
  event_source_link: string | null;
  event_original_link: string | null;
  asset_symbol: string;
  asset_name: string;
  asset_kind: string;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const tier = url.searchParams.get("tier");
  const limit = clamp(numParam(url, "limit") ?? 200, 1, 500);

  const wheres: string[] = [];
  const params: Array<string | number> = [];
  if (status) {
    wheres.push("s.status = ?");
    params.push(status);
  }
  if (tier) {
    wheres.push("s.tier = ?");
    params.push(tier);
  }

  let sql = `
    SELECT s.*,
           n.title         AS event_title,
           n.release_time  AS event_release_time,
           n.source_link   AS event_source_link,
           n.original_link AS event_original_link,
           a.symbol        AS asset_symbol,
           a.name          AS asset_name,
           a.kind          AS asset_kind
    FROM signals s
    LEFT JOIN news_events n ON n.id = s.triggered_by_event_id
    JOIN assets a ON a.id = s.asset_id
  `;
  if (wheres.length) sql += ` WHERE ${wheres.join(" AND ")}`;
  sql += ` ORDER BY s.fired_at DESC LIMIT ?`;
  params.push(limit);

  const rows = db().prepare<typeof params, JoinedSignal>(sql).all(...params);

  // ── Fix C — annotate conflicts ─────────────────────────────────
  // For each pending signal, check if its asset also has an OPPOSITE
  // direction pending signal. Attach has_conflict so the UI can render
  // a warning badge.
  type ConflictRow = { asset_id: string; direction: string };
  const conflictRows = db()
    .prepare<[], ConflictRow>(
      `SELECT asset_id, direction
       FROM signals
       WHERE status = 'pending'
       GROUP BY asset_id, direction`,
    )
    .all();
  const dirsByAsset = new Map<string, Set<string>>();
  for (const r of conflictRows) {
    const s = dirsByAsset.get(r.asset_id) ?? new Set<string>();
    s.add(r.direction);
    dirsByAsset.set(r.asset_id, s);
  }
  const conflicting = new Set<string>();
  for (const [assetId, dirs] of dirsByAsset) {
    if (dirs.has("long") && dirs.has("short")) conflicting.add(assetId);
  }

  const annotated = rows.map((r) => ({
    ...r,
    has_conflict: r.status === "pending" && conflicting.has(r.asset_id),
  }));

  return NextResponse.json({ signals: annotated });
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
