/**
 * Portfolio equity snapshots — the backing store for the equity curve.
 *
 *   POST { address }            → compute the account's current equity
 *                                 composition and record a snapshot, throttled
 *                                 to at most one row per 15 min per address.
 *                                 Returns the live computed values regardless.
 *   GET  ?address=&range=1D|1W|1M|all
 *                               → the ascending snapshot series for the chart,
 *                                 plus the earliest point (for "History starts").
 *
 * SoDEX has no equity/PnL-history endpoint, so the curve is built from these
 * on-visit snapshots (+ an optional daily cron backstop). Read-only against
 * SoDEX; the only writes are to our own Turso table.
 */

import { NextResponse } from "next/server";
import { EquitySnapshots } from "@/lib/db";
import {
  computeSnapshotEquity,
  rangeSince,
  type EquityRange,
} from "@/lib/portfolio/fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One snapshot per address at most this often. */
const THROTTLE_MS = 15 * 60 * 1000;

const isAddress = (v: unknown): v is string =>
  typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/** Drop single-point outliers at read time: a row whose total deviates > 5%
 *  from BOTH neighbours while the neighbours are within 5% of each other — a
 *  one-point dip/spike that instantly recovers, i.e. a partial snapshot that
 *  slipped through. (New writes are guarded all-or-nothing; this cleans history.) */
function dropOutliers<T extends { total_equity: number }>(series: T[]): T[] {
  if (series.length < 3) return series;
  return series.filter((p, i) => {
    if (i === 0 || i === series.length - 1) return true;
    const prev = series[i - 1].total_equity;
    const next = series[i + 1].total_equity;
    const cur = p.total_equity;
    if (!Number.isFinite(prev) || !Number.isFinite(next) || prev === 0 || next === 0)
      return true;
    const devPrev = Math.abs(cur - prev) / Math.abs(prev);
    const devNext = Math.abs(cur - next) / Math.abs(next);
    const neighborsClose = Math.abs(next - prev) / Math.abs(prev) <= 0.05;
    const singlePoint = (cur < prev && cur < next) || (cur > prev && cur > next);
    return !(devPrev > 0.05 && devNext > 0.05 && neighborsClose && singlePoint);
  });
}

export async function POST(req: Request) {
  let address: unknown;
  try {
    ({ address } = await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "bad JSON body" }, { status: 400 });
  }
  if (!isAddress(address)) {
    return NextResponse.json(
      { ok: false, error: "address must be a 0x-prefixed 40-hex string" },
      { status: 400 },
    );
  }

  try {
    // Strict: throws unless perps, spot, wealth AND the price feed all succeed,
    // so a partial fetch can never be recorded as a false dip.
    const computed = await computeSnapshotEquity(address);
    const now = Date.now();

    // Throttle: only write when the newest row is older than the window. A
    // zero-equity account (never deposited) is still worth one baseline row,
    // so we don't special-case it.
    const latest = await EquitySnapshots.latest(address);
    const inserted = !latest || now - latest.ts >= THROTTLE_MS;
    if (inserted) {
      await EquitySnapshots.insert({
        address,
        ts: now,
        perps_equity: computed.perps_equity,
        spot_equity: computed.spot_equity,
        total_equity: computed.total_equity,
        perps_upnl: computed.perps_upnl,
        spot_upnl: null, // no spot cost basis from SoDEX (plan decision 5)
      });
    }

    return NextResponse.json({ ok: true, inserted, computed, ts: now });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "snapshot failed" },
      { status: 502 },
    );
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");
  const range = (url.searchParams.get("range") ?? "all") as EquityRange;
  if (!isAddress(address)) {
    return NextResponse.json(
      { ok: false, error: "address must be a 0x-prefixed 40-hex string" },
      { status: 400 },
    );
  }

  try {
    const [raw, earliest] = await Promise.all([
      EquitySnapshots.series(address, rangeSince(range)),
      EquitySnapshots.earliest(address),
    ]);
    const series = dropOutliers(raw);
    return NextResponse.json({
      ok: true,
      range,
      series,
      earliestTs: earliest?.ts ?? null,
      count: series.length,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "series read failed" },
      { status: 500 },
    );
  }
}
