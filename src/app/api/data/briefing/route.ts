/**
 * GET /api/data/briefing
 *
 * Returns:
 *   { latest: BriefingRow | null, archive: BriefingRow[], top_pick_trade }
 *
 * Used by the /briefing page. The latest briefing is rendered as the
 * hero; archive shows previous days for context. We also hydrate the
 * top pick with the matching live signal's trade levels (entry / stop /
 * target / size / expiry) so the briefing isn't just commentary — it
 * gives an actionable trade.
 */

import { NextResponse } from "next/server";
import { Briefings, db } from "@/lib/db";
import { Market } from "@/lib/sodex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TopPickTrade {
  signal_id: string;
  tier: "auto" | "review" | "info";
  catalyst_subtype: string | null;
  entry_price: number | null;
  stop_pct: number | null;
  target_pct: number | null;
  size_usd: number | null;
  expected_horizon: string | null;
  expires_at: number | null;
  asset_relevance: number | null;
  source_tier: number | null;
  sodex_symbol: string;
  /** Concrete dollar levels derived from entry × pct (UI doesn't have to multiply). */
  stop_price: number | null;
  target_price: number | null;
  /** Risk-reward ratio. */
  rr_ratio: number | null;
  /** Historical backtest scorecard for this (event_type, sentiment) pair —
   *  builds investor confidence by quantifying how the SAME catalyst class
   *  has played out on impact_metrics-backed historical events. */
  backtest: {
    sample_size: number;
    avg_impact_1d_pct: number | null;
    avg_impact_3d_pct: number | null;
    hit_rate_1d_pct: number | null;
    /** Direction the historical move SHOULD have gone given sentiment.
     *  Used by the UI to label "in-direction" hit rate. */
    expected_direction: "up" | "down" | "either";
    event_type: string;
    sentiment: string;
  } | null;
}

/**
 * Look up the live pending signal that backs the briefing's top pick.
 * Match on asset_id + direction. The briefing was generated from the
 * SAME pending-signals snapshot we read here, so the match is reliable
 * unless the signal expired between briefing-generation and now (in
 * which case we return null and the UI hides the trade panel).
 */
async function findTopPickTrade(
  asset_id: string | undefined,
  direction: string | undefined,
): Promise<TopPickTrade | null> {
  if (!asset_id || !direction) return null;
  if (direction !== "long" && direction !== "short") return null;

  interface Row {
    id: string;
    sodex_symbol: string;
    tier: "auto" | "review" | "info";
    confidence: number;
    catalyst_subtype: string | null;
    suggested_size_usd: number | null;
    suggested_stop_pct: number | null;
    suggested_target_pct: number | null;
    expected_horizon: string | null;
    expires_at: number | null;
    asset_relevance: number | null;
    source_tier: number | null;
  }
  const sig = db()
    .prepare<[string, string], Row>(
      `SELECT id, sodex_symbol, tier, confidence, catalyst_subtype,
              suggested_size_usd, suggested_stop_pct, suggested_target_pct,
              expected_horizon, expires_at, asset_relevance, source_tier
       FROM signals
       WHERE asset_id = ? AND direction = ? AND status = 'pending'
       ORDER BY confidence DESC
       LIMIT 1`,
    )
    .get(asset_id, direction);
  if (!sig) return null;

  // Pull the source event's classification so we can look up the backtest
  // bucket — impact_metrics is keyed by event_id and we aggregate by
  // (event_type, sentiment) for the directional hit-rate.
  interface ClassRow {
    event_type: string;
    sentiment: string;
  }
  const cls = db()
    .prepare<[string], ClassRow>(
      `SELECT c.event_type, c.sentiment
       FROM signals s
       JOIN classifications c ON c.event_id = s.triggered_by_event_id
       WHERE s.id = ?`,
    )
    .get(sig.id);

  let backtest: TopPickTrade["backtest"] = null;
  if (cls) {
    interface BT {
      n: number;
      avg_1d: number | null;
      avg_3d: number | null;
      hits_1d: number;
    }
    // "Hit" definition: move at T+1d aligns with sentiment direction.
    // For positive sentiment we count >0 moves; for negative we count <0.
    // Neutral sentiment doesn't have a direction prediction → no hit rate.
    const aligned =
      cls.sentiment === "positive"
        ? "im.impact_pct_1d > 0"
        : cls.sentiment === "negative"
          ? "im.impact_pct_1d < 0"
          : "1=0";
    const bt = db()
      .prepare<[string, string], BT>(
        `SELECT COUNT(*) AS n,
                ROUND(AVG(im.impact_pct_1d), 2) AS avg_1d,
                ROUND(AVG(im.impact_pct_3d), 2) AS avg_3d,
                SUM(CASE WHEN ${aligned} THEN 1 ELSE 0 END) AS hits_1d
         FROM impact_metrics im
         JOIN classifications c ON c.event_id = im.event_id
         WHERE c.event_type = ? AND c.sentiment = ?
           AND im.impact_pct_1d IS NOT NULL`,
      )
      .get(cls.event_type, cls.sentiment);
    if (bt && bt.n >= 3) {
      backtest = {
        sample_size: bt.n,
        avg_impact_1d_pct: bt.avg_1d,
        avg_impact_3d_pct: bt.avg_3d,
        hit_rate_1d_pct:
          cls.sentiment === "neutral"
            ? null
            : Math.round((bt.hits_1d / bt.n) * 1000) / 10,
        expected_direction:
          cls.sentiment === "positive"
            ? "up"
            : cls.sentiment === "negative"
              ? "down"
              : "either",
        event_type: cls.event_type,
        sentiment: cls.sentiment,
      };
    }
  }

  // Live entry price from SoDEX.
  let entry: number | null = null;
  try {
    const tickers = await Market.getAllTickersBySymbol();
    const t = tickers.get(sig.sodex_symbol);
    if (t) {
      const n = Number(t.lastPx);
      entry = Number.isFinite(n) && n > 0 ? n : null;
    }
  } catch {
    /* market down or symbol not found — leave entry null */
  }

  // Concrete stop/target levels in dollars. For long: stop below, target
  // above. For short: stop above, target below.
  let stop_price: number | null = null;
  let target_price: number | null = null;
  if (entry != null) {
    if (sig.suggested_stop_pct != null) {
      stop_price =
        direction === "long"
          ? entry * (1 - sig.suggested_stop_pct / 100)
          : entry * (1 + sig.suggested_stop_pct / 100);
    }
    if (sig.suggested_target_pct != null) {
      target_price =
        direction === "long"
          ? entry * (1 + sig.suggested_target_pct / 100)
          : entry * (1 - sig.suggested_target_pct / 100);
    }
  }
  const rr =
    sig.suggested_stop_pct && sig.suggested_target_pct
      ? sig.suggested_target_pct / sig.suggested_stop_pct
      : null;

  return {
    signal_id: sig.id,
    tier: sig.tier,
    catalyst_subtype: sig.catalyst_subtype,
    entry_price: entry,
    stop_pct: sig.suggested_stop_pct,
    target_pct: sig.suggested_target_pct,
    size_usd: sig.suggested_size_usd,
    expected_horizon: sig.expected_horizon,
    expires_at: sig.expires_at,
    asset_relevance: sig.asset_relevance,
    source_tier: sig.source_tier,
    sodex_symbol: sig.sodex_symbol,
    stop_price,
    target_price,
    rr_ratio: rr != null ? Math.round(rr * 100) / 100 : null,
    backtest,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const date = url.searchParams.get("date");
  const archiveLimit = Math.min(
    30,
    Math.max(1, Number(url.searchParams.get("archive_limit") ?? 14)),
  );

  if (date) {
    const single = Briefings.getBriefing(date);
    let top_pick_trade: TopPickTrade | null = null;
    if (single?.top_pick) {
      const tp = single.top_pick as {
        asset_id?: string;
        direction?: string;
      };
      top_pick_trade = await findTopPickTrade(tp.asset_id, tp.direction);
    }
    return NextResponse.json({ briefing: single ?? null, top_pick_trade });
  }

  const latest = Briefings.getLatestBriefing() ?? null;
  let top_pick_trade: TopPickTrade | null = null;
  if (latest?.top_pick) {
    const tp = latest.top_pick as { asset_id?: string; direction?: string };
    top_pick_trade = await findTopPickTrade(tp.asset_id, tp.direction);
  }

  // Archive excludes the latest so the UI doesn't render it twice.
  const archive = Briefings.listBriefings(archiveLimit + 1).filter(
    (b) => !latest || b.date !== latest.date,
  );

  return NextResponse.json({ latest, archive, top_pick_trade });
}
