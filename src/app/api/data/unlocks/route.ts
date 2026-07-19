/**
 * GET /api/data/unlocks
 *
 * Upcoming token unlocks for the /unlocks calendar, LEFT-joined to the asset
 * (display name/kind) and to any SHORT signal the generator produced for that
 * unlock (via event_chain_id = 'unlock:' || u.id), so the table can render a
 * signal badge + a link to execute without extra lookups.
 *
 * Query: ?limit=N (default 200)
 */

import { NextResponse } from "next/server";
import { all } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface UnlockJoinRow {
  id: string;
  symbol: string;
  protocol_slug: string;
  asset_id: string | null;
  sodex_symbol: string | null;
  tradable_perp: number;
  unlock_at: number;
  unlock_date: string;
  unlock_kind: string | null;
  tokens_unlocked: number | null;
  unlock_value_usd: number | null;
  pct_of_circulating: number | null;
  pct_of_max_supply: number | null;
  categories_json: string | null;
  asset_name: string | null;
  asset_kind: string | null;
  signal_id: string | null;
  signal_tier: string | null;
  signal_status: string | null;
  suggested_size_usd: number | null;
  suggested_stop_pct: number | null;
  suggested_target_pct: number | null;
  signal_confidence: number | null;
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 200) || 200);

  try {
    const rows = await all<UnlockJoinRow>(
      `SELECT u.id, u.symbol, u.protocol_slug, u.asset_id, u.sodex_symbol,
              u.tradable_perp, u.unlock_at, u.unlock_date, u.unlock_kind,
              u.tokens_unlocked, u.unlock_value_usd, u.pct_of_circulating,
              u.pct_of_max_supply, u.categories_json,
              a.name AS asset_name, a.kind AS asset_kind,
              s.id AS signal_id, s.tier AS signal_tier, s.status AS signal_status,
              s.suggested_size_usd, s.suggested_stop_pct, s.suggested_target_pct,
              s.confidence AS signal_confidence
       FROM token_unlocks u
       LEFT JOIN assets  a ON a.id = u.asset_id
       LEFT JOIN signals s ON s.event_chain_id = 'unlock:' || u.id
       WHERE u.unlock_at > ?
       ORDER BY u.unlock_at ASC
       LIMIT ?`,
      [Date.now(), limit],
    );
    return NextResponse.json({ unlocks: rows });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "unlocks query failed", unlocks: [] },
      { status: 500 },
    );
  }
}
