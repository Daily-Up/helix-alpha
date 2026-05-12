/**
 * GET /api/data/calibration?window=30
 *
 * Returns the 5 calibration panels in one round-trip:
 *   - hit rate by tier
 *   - hit rate by catalyst subtype (n >= 5)
 *   - conviction calibration curve (10pt bins)
 *   - PnL by (subtype, asset_class)
 *   - top winners + losers (limit 10 each)
 *
 * No LLM calls — pure SQL. Fast even on 10k+ outcome rows.
 */

import { NextResponse } from "next/server";
import {
  hitRateByTier,
  hitRateByCatalystSubtype,
  convictionCalibrationCurve,
  pnlBySubtypeAndAssetClass,
  topWinnersAndLosers,
  getFrameworkSummary,
} from "@/lib/queries/calibration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const window = clamp(numParam(url, "window") ?? 30, 1, 365);
  // Part 1 of v2.1 attribution: framework filter. Accepted values are
  // 'v1' / 'v2' / undefined (= 'All'). When undefined every panel
  // aggregates across both frameworks (existing behavior).
  const fwParam = url.searchParams.get("framework");
  const frameworkVersion =
    fwParam === "v1" || fwParam === "v2" ? fwParam : undefined;

  const t0 = Date.now();
  const opts = { window_days: window, frameworkVersion };
  const payload = {
    window_days: window,
    framework_version: frameworkVersion ?? null,
    generated_at: Date.now(),
    by_tier: hitRateByTier(opts),
    by_subtype: hitRateByCatalystSubtype(opts),
    calibration_curve: convictionCalibrationCurve(opts),
    pnl_grid: pnlBySubtypeAndAssetClass(opts),
    extremes: topWinnersAndLosers({ ...opts, limit: 10 }),
    framework_summary: getFrameworkSummary({ window_days: window }),
    latency_ms: Date.now() - t0,
  };
  return NextResponse.json(payload);
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
