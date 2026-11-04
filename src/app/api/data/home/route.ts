/**
 * GET /api/data/home
 *
 * Single endpoint that powers the marketing homepage. Wave 2: async.
 */

import { NextResponse } from "next/server";
import { Briefings, Postmortem, all, get } from "@/lib/db";
import { fetchCatalog } from "@/lib/wealth/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  interface SigStats {
    total_pending: number;
    auto: number;
    review: number;
    info: number;
    avg_conf: number | null;
  }
  const sigStats = await get<SigStats>(
    // COALESCE the SUMs — with zero pending rows SQLite returns NULL for a
    // bare SUM, which rendered as "null auto · null review · null info".
    `SELECT
       COUNT(*) AS total_pending,
       COALESCE(SUM(CASE WHEN tier = 'auto' THEN 1 ELSE 0 END), 0) AS auto,
       COALESCE(SUM(CASE WHEN tier = 'review' THEN 1 ELSE 0 END), 0) AS review,
       COALESCE(SUM(CASE WHEN tier = 'info' THEN 1 ELSE 0 END), 0) AS info,
       AVG(confidence) AS avg_conf
     FROM signals
     WHERE status = 'pending'`,
  );

  interface TopSig {
    id: string;
    asset_symbol: string;
    asset_kind: string;
    direction: "long" | "short";
    tier: "auto" | "review" | "info";
    confidence: number;
    fired_at: number;
    event_title: string | null;
    event_type: string | null;
  }
  const topSignals = await all<TopSig>(
    `SELECT s.id, a.symbol AS asset_symbol, a.kind AS asset_kind,
            s.direction, s.tier, s.confidence, s.fired_at,
            n.title AS event_title, c.event_type AS event_type
     FROM signals s
     JOIN assets a ON a.id = s.asset_id
     LEFT JOIN news_events n ON n.id = s.triggered_by_event_id
     LEFT JOIN classifications c ON c.event_id = s.triggered_by_event_id
     WHERE s.status = 'pending'
     ORDER BY s.confidence DESC, s.fired_at DESC
     LIMIT 3`,
  );

  // ── SoDEX Wealth snapshot ─────────────────────────────────────
  // Catalog-level (not wallet-specific) highlights for the dashboard tile:
  // the top Stable Earn APY + the highest-return products. All read from the
  // live SoDEX Wealth API; optional (the home page renders without it).
  let wealthSnapshot: {
    product_count: number;
    top_yield: { name: string; apy: number } | null;
    highlights: Array<{
      fund_id: string;
      name: string;
      category: string;
      metric_label: string;
      metric_value: number | null;
      change_pct: number | null;
    }>;
  } = { product_count: 0, top_yield: null, highlights: [] };
  try {
    const funds = await fetchCatalog();
    const yields = funds
      .filter((f) => f.category === "stable_earn" && f.apy7d != null)
      .sort((a, b) => (b.apy7d ?? 0) - (a.apy7d ?? 0));
    const byReturn = [...funds]
      .filter((f) => f.headlineValue != null)
      .sort((a, b) => (b.headlineValue ?? 0) - (a.headlineValue ?? 0));
    wealthSnapshot = {
      product_count: funds.length,
      top_yield: yields[0]
        ? { name: yields[0].displayName, apy: yields[0].apy7d ?? 0 }
        : null,
      highlights: byReturn.slice(0, 5).map((f) => ({
        fund_id: f.fundId,
        name: f.displayName,
        category: f.category,
        metric_label: f.headlineLabel,
        metric_value: f.headlineValue,
        change_pct: f.changePct,
      })),
    };
  } catch {
    /* wealth snapshot optional */
  }

  const briefing = await Briefings.getLatestBriefing();

  const overall = await Postmortem.overallStats({
    since_ms: 30 * 24 * 60 * 60 * 1000,
  });
  const byType = await Postmortem.statsByEventType({
    since_ms: 30 * 24 * 60 * 60 * 1000,
  });
  const evaluable = byType.filter(
    (b) => b.count >= 2 && b.hit_rate_3d != null,
  );
  evaluable.sort((a, b) => (b.hit_rate_3d ?? 0) - (a.hit_rate_3d ?? 0));
  const bestEventType = evaluable[0] ?? null;

  interface Counts {
    total_events: number;
    total_classified: number;
    total_signals: number;
    total_briefings: number;
    last_event_at: number | null;
  }
  const counts = await get<Counts>(
    `SELECT
       (SELECT COUNT(*) FROM news_events)                      AS total_events,
       (SELECT COUNT(*) FROM classifications)                  AS total_classified,
       (SELECT COUNT(*) FROM signals)                          AS total_signals,
       (SELECT COUNT(*) FROM briefings)                        AS total_briefings,
       (SELECT MAX(release_time) FROM news_events)             AS last_event_at`,
  );

  return NextResponse.json({
    counts,
    signal_stats: sigStats,
    top_signals: topSignals,
    wealth: wealthSnapshot,
    briefing: briefing
      ? {
          date: briefing.date,
          headline: briefing.headline,
          regime: briefing.regime,
          top_pick: briefing.top_pick,
          generated_at: briefing.generated_at,
        }
      : null,
    calibration: {
      overall,
      best_event_type: bestEventType,
    },
  });
}
