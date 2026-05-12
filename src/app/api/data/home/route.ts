/**
 * GET /api/data/home
 *
 * Single endpoint that powers the marketing homepage. Aggregates a
 * lean snapshot from across the system so the page can render in one
 * fetch without 5 separate API calls. Response intentionally compact.
 */

import { NextResponse } from "next/server";
import {
  Assets,
  Briefings,
  IndexFund,
  Postmortem,
  db,
} from "@/lib/db";
import { Market } from "@/lib/sodex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // ── Stats: today's pending signal count, conviction breakdown ──
  interface SigStats {
    total_pending: number;
    auto: number;
    review: number;
    info: number;
    avg_conf: number | null;
  }
  const sigStats = db()
    .prepare<[], SigStats>(
      `SELECT
         COUNT(*) AS total_pending,
         SUM(CASE WHEN tier = 'auto' THEN 1 ELSE 0 END) AS auto,
         SUM(CASE WHEN tier = 'review' THEN 1 ELSE 0 END) AS review,
         SUM(CASE WHEN tier = 'info' THEN 1 ELSE 0 END) AS info,
         AVG(confidence) AS avg_conf
       FROM signals
       WHERE status = 'pending'`,
    )
    .get();

  // Top 3 highest-conviction pending signals (with event title).
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
  const topSignals = db()
    .prepare<[], TopSig>(
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
    )
    .all();

  // ── AlphaIndex snapshot ───────────────────────────────────────
  const idx = IndexFund.getIndex("alphacore");
  const positions = IndexFund.listPositions("alphacore");
  let tickers = new Map<string, { lastPx: string }>();
  try {
    tickers = (await Market.getAllTickersBySymbol()) as unknown as Map<
      string,
      { lastPx: string }
    >;
  } catch {
    /* live prices optional */
  }
  const livePrice = (sym: string): number | null => {
    const t = tickers.get(sym);
    if (!t) return null;
    const n = Number(t.lastPx);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  let invested = 0;
  const positionViews: Array<{
    symbol: string;
    kind: string;
    weight_pct: number;
    pnl_pct: number | null;
    rationale: string | null;
    value: number;
  }> = [];
  for (const p of positions) {
    const a = Assets.getAssetById(p.asset_id);
    if (!a) continue;
    const sym = a.tradable?.symbol ?? "";
    const px = sym ? livePrice(sym) : null;
    const value = px != null ? p.quantity * px : p.current_value_usd;
    invested += value;
    const pnl_pct =
      px != null && p.avg_entry_price != null && p.avg_entry_price > 0
        ? ((px - p.avg_entry_price) / p.avg_entry_price) * 100
        : null;
    positionViews.push({
      symbol: a.symbol,
      kind: a.kind,
      weight_pct: 0,
      pnl_pct,
      rationale: p.rationale,
      value,
    });
  }
  const lastNav = IndexFund.listNavHistory("alphacore", 1)[0];
  const navTotal = lastNav?.nav_usd ?? idx?.starting_nav ?? 0;
  const cash = Math.max(0, navTotal - invested);
  const totalNav = invested + cash;
  for (const p of positionViews) {
    p.weight_pct = totalNav > 0 ? (p.value / totalNav) * 100 : 0;
  }
  positionViews.sort((a, b) => b.value - a.value);
  const indexSnapshot = {
    nav: totalNav,
    starting_nav: idx?.starting_nav ?? 0,
    pnl_pct:
      idx && idx.starting_nav > 0
        ? ((totalNav - idx.starting_nav) / idx.starting_nav) * 100
        : 0,
    top_positions: positionViews.slice(0, 5).map((p) => ({
      symbol: p.symbol,
      kind: p.kind,
      weight_pct: p.weight_pct,
      pnl_pct: p.pnl_pct,
      rationale: p.rationale,
    })),
  };

  // ── Latest briefing (preview) ─────────────────────────────────
  const briefing = Briefings.getLatestBriefing();

  // ── Calibration: overall + best event_type ────────────────────
  const overall = Postmortem.overallStats({
    since_ms: 30 * 24 * 60 * 60 * 1000,
  });
  const byType = Postmortem.statsByEventType({
    since_ms: 30 * 24 * 60 * 60 * 1000,
  });
  const evaluable = byType.filter(
    (b) => b.count >= 2 && b.hit_rate_3d != null,
  );
  evaluable.sort((a, b) => (b.hit_rate_3d ?? 0) - (a.hit_rate_3d ?? 0));
  const bestEventType = evaluable[0] ?? null;

  // ── System counts (transparency / "this is real" proof) ──────
  interface Counts {
    total_events: number;
    total_classified: number;
    total_signals: number;
    total_briefings: number;
    last_event_at: number | null;
  }
  const counts = db()
    .prepare<[], Counts>(
      `SELECT
         (SELECT COUNT(*) FROM news_events)                      AS total_events,
         (SELECT COUNT(*) FROM classifications)                  AS total_classified,
         (SELECT COUNT(*) FROM signals)                          AS total_signals,
         (SELECT COUNT(*) FROM briefings)                        AS total_briefings,
         (SELECT MAX(release_time) FROM news_events)             AS last_event_at`,
    )
    .get();

  return NextResponse.json({
    counts,
    signal_stats: sigStats,
    top_signals: topSignals,
    index: indexSnapshot,
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
