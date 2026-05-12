/**
 * GET /api/data/patterns
 *
 * Returns the empirical pattern library — what each event_type has
 * historically done to price across our backtest universe.
 *
 * Output:
 *   - patterns_by_event_type: per event_type, all (sentiment × horizon)
 *     breakdowns + summary
 *   - hardcoded_vs_empirical: side-by-side comparison so the user can
 *     see whether our hand-tuned tradability scores match reality
 *   - sample_total: total impact samples backing the analysis
 */

import { NextResponse } from "next/server";
import { computePatternsByEventType, empiricalTradability } from "@/lib/analysis";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hardcoded scores from signal-generator.ts so the UI can compare.
// Keep in sync if you tune the generator.
const HARDCODED_TRADABILITY: Record<string, number> = {
  exploit: 0.95,
  listing: 0.9,
  regulatory: 0.8,
  etf_flow: 0.75,
  earnings: 0.7,
  treasury: 0.7,
  social_platform: 0.6,
  unlock: 0.55,
  airdrop: 0.5,
  macro: 0.5,
  tech_update: 0.4,
  security: 0.4,
  partnership: 0.4,
  fundraising: 0.35,
  narrative: 0.25,
  governance: 0.2,
  other: 0.1,
};

export async function GET() {
  const byType = computePatternsByEventType();
  const MIN_SAMPLES = 5;
  // NOTE: empiricalTradability() returns a Map keyed by
  // `${event_type}|${sentiment}` — we DON'T want to use it here keyed
  // by raw event_type (the previous bug). Instead, resolve the dominant-
  // sentiment 1d bucket from byType per event_type and pull its
  // empirical_tradability score directly. The audit then compares the
  // hand-curated HARDCODED_TRADABILITY against real evidence.
  void empiricalTradability; // kept exported elsewhere; not used here

  const sampleTotal = byType.reduce(
    (s, t) => s + t.all.filter((p) => p.horizon === "1d").reduce((a, b) => a + b.n, 0),
    0,
  );

  /** Per-event_type, return the empirical 1d tradability of the
   *  dominant-by-count sentiment bucket — but only when n ≥ MIN_SAMPLES. */
  function empScoreFor(eventType: string): number | null {
    const t = byType.find((x) => x.event_type === eventType);
    if (!t) return null;
    const oneDay = t.all.filter((p) => p.horizon === "1d");
    if (oneDay.length === 0) return null;
    const dominant = [...oneDay].sort((a, b) => b.n - a.n)[0]!;
    if (dominant.n < MIN_SAMPLES) return null;
    return dominant.empirical_tradability;
  }

  const comparison = Object.keys(HARDCODED_TRADABILITY).map((event_type) => {
    const ourScore = HARDCODED_TRADABILITY[event_type];
    const empScore = empScoreFor(event_type);
    return {
      event_type,
      hardcoded: ourScore,
      empirical: empScore,
      delta:
        empScore == null ? null : Math.round((empScore - ourScore) * 100) / 100,
      verdict:
        empScore == null
          ? "insufficient_samples"
          : empScore >= ourScore + 0.1
            ? "underrated"
            : empScore <= ourScore - 0.1
              ? "overrated"
              : "calibrated",
    };
  });

  // Per-asset breakdown — which assets actually move on which event types.
  interface AssetRow {
    event_type: string;
    asset_id: string;
    n: number;
    avg: number;
  }
  const perAsset = db()
    .prepare<[], AssetRow>(
      `SELECT c.event_type    AS event_type,
              im.asset_id     AS asset_id,
              COUNT(*)        AS n,
              AVG(im.impact_pct_1d) AS avg
       FROM impact_metrics im
       JOIN classifications c ON c.event_id = im.event_id
       WHERE im.impact_pct_1d IS NOT NULL
       GROUP BY c.event_type, im.asset_id
       HAVING n >= 2
       ORDER BY n DESC, ABS(avg) DESC
       LIMIT 50`,
    )
    .all();

  return NextResponse.json({
    sample_total: sampleTotal,
    patterns_by_event_type: byType,
    hardcoded_vs_empirical: comparison,
    per_asset: perAsset,
  });
}
