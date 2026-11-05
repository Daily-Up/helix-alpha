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

/** First paragraph of the briefing body, markdown stripped, for a 2-line
 *  dashboard summary. Never fabricates — returns "" if the body is empty. */
function briefingSummary(body: string): string {
  const firstPara = (body ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0);
  if (!firstPara) return "";
  const plain = firstPara
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 240 ? plain.slice(0, 237).trimEnd() + "…" : plain;
}

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
    sodex_symbol: string | null;
    direction: "long" | "short";
    tier: "auto" | "review" | "info";
    confidence: number;
    fired_at: number;
    event_title: string | null;
    event_type: string | null;
  }
  // Only FRESH pending signals. Two freshness gates:
  //   • within their own horizon (expires_at in the future), AND
  //   • event-driven signals must have fired within the last 48h — a catalyst
  //     older than that is stale news even if its horizon runs longer. This is
  //     why 3d/2d-old event signals used to linger: the horizon (expires_at)
  //     was still open. Pattern-driven signals (no triggering event) keep the
  //     horizon-only rule.
  const now = Date.now();
  const fresh48 = now - 48 * 60 * 60 * 1000;
  const topSignals = await all<TopSig>(
    `SELECT s.id, a.symbol AS asset_symbol, a.kind AS asset_kind,
            s.sodex_symbol AS sodex_symbol,
            s.direction, s.tier, s.confidence, s.fired_at,
            n.title AS event_title, c.event_type AS event_type
     FROM signals s
     JOIN assets a ON a.id = s.asset_id
     LEFT JOIN news_events n ON n.id = s.triggered_by_event_id
     LEFT JOIN classifications c ON c.event_id = s.triggered_by_event_id
     WHERE s.status = 'pending'
       AND (s.expires_at IS NULL OR s.expires_at > ?)
       AND (s.triggered_by_event_id IS NULL OR s.fired_at >= ?)
     ORDER BY s.confidence DESC, s.fired_at DESC
     LIMIT 5`,
    [now, fresh48],
  );

  // Fallback for the "Top pending signals" card: when nothing is live, show the
  // 3 most recently graded signals with their actual outcome instead of an
  // empty panel.
  const recentGraded =
    topSignals.length === 0 ? await Postmortem.recentGradedOutcomes(3) : [];

  // ── SoDEX Wealth snapshot ─────────────────────────────────────
  // Catalog-level (not wallet-specific) highlights for the dashboard tile:
  // the top Stable Earn APY + the highest-return products. All read from the
  // live SoDEX Wealth API; optional (the home page renders without it).
  let wealthSnapshot: {
    product_count: number;
    top_yield: { name: string; apy: number } | null;
    usdc_earn: { name: string; apy: number; fund_id: string } | null;
    highlights: Array<{
      fund_id: string;
      name: string;
      symbol: string | null;
      category: string;
      metric_label: string;
      metric_value: number | null;
      roi_1y: number | null;
      change_pct: number | null;
    }>;
  } = { product_count: 0, top_yield: null, usdc_earn: null, highlights: [] };
  try {
    const funds = await fetchCatalog();
    const yields = funds
      .filter((f) => f.category === "stable_earn" && f.apy7d != null)
      .sort((a, b) => (b.apy7d ?? 0) - (a.apy7d ?? 0));
    // The specific USDC Earn product for the stat tile; fall back to the top
    // Stable Earn yield if it isn't in the catalog.
    const usdcEarnFund =
      funds.find(
        (f) =>
          f.category === "stable_earn" &&
          /usdc/i.test(`${f.displayName} ${f.symbol ?? ""}`) &&
          /earn/i.test(`${f.displayName} ${f.symbol ?? ""}`),
      ) ?? yields[0];
    const byReturn = [...funds]
      .filter((f) => f.headlineValue != null)
      .sort((a, b) => (b.headlineValue ?? 0) - (a.headlineValue ?? 0));
    wealthSnapshot = {
      product_count: funds.length,
      top_yield: yields[0]
        ? { name: yields[0].displayName, apy: yields[0].apy7d ?? 0 }
        : null,
      usdc_earn:
        usdcEarnFund && usdcEarnFund.apy7d != null
          ? {
              name: usdcEarnFund.displayName,
              apy: usdcEarnFund.apy7d,
              fund_id: usdcEarnFund.fundId,
            }
          : null,
      highlights: byReturn.slice(0, 5).map((f) => ({
        fund_id: f.fundId,
        name: f.displayName,
        symbol: f.symbol ?? null,
        category: f.category,
        metric_label: f.headlineLabel,
        metric_value: f.headlineValue,
        roi_1y: f.roi1Y,
        change_pct: f.changePct,
      })),
    };
  } catch {
    /* wealth snapshot optional */
  }

  const briefing = await Briefings.getLatestBriefing();

  // Resolve the briefing top pick's SoDEX market so the card's Trade button can
  // deep-link the terminal. Only for directional (long/short) picks that map to
  // a perp market; "watch" picks and unmapped assets get no button.
  let topPickSodex: string | null = null;
  if (
    briefing?.top_pick &&
    (briefing.top_pick.direction === "long" ||
      briefing.top_pick.direction === "short")
  ) {
    const tp = briefing.top_pick;
    const row = await get<{ sodex_symbol: string | null }>(
      `SELECT sodex_symbol FROM assets WHERE id = ? OR symbol = ? LIMIT 1`,
      [tp.asset_id ?? "", tp.asset_symbol ?? ""],
    );
    topPickSodex = row?.sodex_symbol ?? null;
  }

  // Calibration reads the LIVE grader (signal_outcomes), written by the
  // resolution job every tick — not impact_metrics, which depends on the
  // compute-impact job and is empty when that job hasn't run. This makes the
  // "hit rate" tile reflect grading that actually happens.
  const graded = await Postmortem.gradedOutcomeStats(
    30 * 24 * 60 * 60 * 1000,
  );

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
    recent_graded: recentGraded,
    wealth: wealthSnapshot,
    briefing: briefing
      ? {
          date: briefing.date,
          headline: briefing.headline,
          summary: briefingSummary(briefing.body),
          regime: briefing.regime,
          top_pick: briefing.top_pick,
          top_pick_sodex: topPickSodex,
          generated_at: briefing.generated_at,
        }
      : null,
    calibration: {
      graded: graded.graded,
      hit_rate: graded.hit_rate,
      first_grade_at: graded.first_grade_at,
    },
  });
}
