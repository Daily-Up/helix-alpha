/**
 * GET /api/data/alphaindex/signal-attribution?id=alphacore
 *
 * Returns the per-rebalance signal-tilt attribution rows for the
 * AlphaIndex dashboard's "Signal Contribution" panel (Part 3). For
 * each rebalance we surface:
 *   - weight deltas in bps (actual − momentum-only counterfactual)
 *   - realized USD P&L per asset (NULL until the next rebalance resolves)
 *   - sanity flag (false = counterfactual was malformed and zeroed)
 *
 * Aggregates a top-level total over the most-recent N resolved rows so
 * the UI can show "signals contributed +$X over the last K rebalances."
 */

import { NextResponse } from "next/server";
import { IndexFund, Assets } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const indexId = url.searchParams.get("id") ?? "alphacore";

  const idx = IndexFund.getIndex(indexId);
  if (!idx) {
    return NextResponse.json({ ok: false, error: "index not found" }, { status: 404 });
  }

  const rows = IndexFund.listSignalAttributions(indexId, 30);
  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      total_pnl_usd: 0,
      resolved_count: 0,
      pending_count: 0,
      rebalances: [],
    });
  }

  // Build asset display map (symbol/name) for the UI.
  const allAssetIds = new Set<string>();
  for (const r of rows) {
    for (const id of Object.keys(r.weight_deltas_bps)) allAssetIds.add(id);
    if (r.realized_pnl_usd) {
      for (const id of Object.keys(r.realized_pnl_usd)) allAssetIds.add(id);
    }
  }
  const symbols: Record<string, { symbol: string; name: string }> = {};
  for (const id of allAssetIds) {
    const a = Assets.getAssetById(id);
    if (a) symbols[id] = { symbol: a.symbol, name: a.name };
  }

  const resolved = rows.filter((r) => r.total_pnl_usd != null && r.sanity_ok);
  const pending = rows.filter((r) => r.total_pnl_usd == null && r.sanity_ok);
  const total = resolved.reduce((s, r) => s + (r.total_pnl_usd ?? 0), 0);

  return NextResponse.json({
    ok: true,
    total_pnl_usd: Math.round(total * 100) / 100,
    resolved_count: resolved.length,
    pending_count: pending.length,
    symbols,
    rebalances: rows.map((r) => ({
      id: r.id,
      rebalance_id: r.rebalance_id,
      asof_ms: r.asof_ms,
      pre_nav_usd: r.pre_nav_usd,
      weight_deltas_bps: r.weight_deltas_bps,
      realized_pnl_usd: r.realized_pnl_usd,
      total_pnl_usd: r.total_pnl_usd,
      sanity_ok: r.sanity_ok,
      sanity_note: r.sanity_note,
      resolved_at: r.resolved_at,
    })),
  });
}
