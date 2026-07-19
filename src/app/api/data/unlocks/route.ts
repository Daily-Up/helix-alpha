/**
 * GET /api/data/unlocks
 *
 * Upcoming token unlocks for the /unlocks calendar, LEFT-joined to the asset
 * (display name/kind) and enriched with a computed SHORT trade plan
 * (eligibility, recipient class, materiality, entry/cover timing, phase).
 * The plan is computed at read time from the row (phase depends on "now"),
 * so retuning needs no re-ingest. Unlock shorts execute directly from
 * /unlocks — they do NOT appear in the Live Signals feed.
 *
 * Query: ?limit=N (default 250)
 */

import { NextResponse } from "next/server";
import { all } from "@/lib/db";
import { computeUnlockTradePlan, type UnlockTradePlan } from "@/lib/unlocks/plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface UnlockDbRow {
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
  price_usd: number | null;
  pct_of_circulating: number | null;
  pct_of_max_supply: number | null;
  categories_json: string | null;
  asset_name: string | null;
  asset_kind: string | null;
}

export type UnlockRowWithPlan = UnlockDbRow & { plan: UnlockTradePlan };

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 250) || 250);

  try {
    const rows = await all<UnlockDbRow>(
      `SELECT u.id, u.symbol, u.protocol_slug, u.asset_id, u.sodex_symbol,
              u.tradable_perp, u.unlock_at, u.unlock_date, u.unlock_kind,
              u.tokens_unlocked, u.unlock_value_usd, u.price_usd,
              u.pct_of_circulating, u.pct_of_max_supply, u.categories_json,
              a.name AS asset_name, a.kind AS asset_kind
       FROM token_unlocks u
       LEFT JOIN assets a ON a.id = u.asset_id
       WHERE u.unlock_at > ?
       ORDER BY u.unlock_at ASC
       LIMIT ?`,
      [Date.now(), limit],
    );
    const now = Date.now();
    const unlocks: UnlockRowWithPlan[] = rows.map((r) => ({
      ...r,
      plan: computeUnlockTradePlan(r, now),
    }));
    return NextResponse.json({ unlocks });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "unlocks query failed", unlocks: [] },
      { status: 500 },
    );
  }
}
