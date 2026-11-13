/**
 * GET /api/data/home
 *
 * Powers the dashboard. It's heavy — several DB reads plus the live SoDEX
 * Wealth catalog (an external HTTP call) — and it used to run every step
 * SEQUENTIALLY, so a cold load took ~10s ("Loading live snapshot…" hung).
 *
 * Two fixes here:
 *   1. The independent reads run in PARALLEL (Promise.all).
 *   2. The assembled payload is cached in kv_cache with stale-while-revalidate:
 *      a fresh cache (<FRESH_MS) serves instantly with no work; an older cache
 *      still serves instantly and refreshes in the background (next/server
 *      `after`); only a cold, empty cache blocks on a compute. So virtually
 *      every visit is an instant cache read.
 */

import { after, NextResponse } from "next/server";
import { Briefings, Postmortem, all, get, run } from "@/lib/db";
import { fetchCatalog } from "@/lib/wealth/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_KEY = "home_snapshot";
const FRESH_MS = 60_000; // serve cached with no refresh if younger than this

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

interface SigStats {
  total_pending: number;
  auto: number;
  review: number;
  info: number;
  avg_conf: number | null;
}
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
interface Counts {
  total_events: number;
  total_classified: number;
  total_signals: number;
  total_briefings: number;
  last_event_at: number | null;
}

type Catalog = Awaited<ReturnType<typeof fetchCatalog>>;
/** Wealth catalog is optional — never let it fail the dashboard. */
async function safeCatalog(): Promise<Catalog> {
  try {
    return await fetchCatalog();
  } catch {
    return [] as Catalog;
  }
}

/** Resolve the briefing top-pick's SoDEX market for the card's Trade button. */
async function resolveTopPickSodex(
  briefing: Awaited<ReturnType<typeof Briefings.getLatestBriefing>>,
): Promise<string | null> {
  const tp = briefing?.top_pick;
  if (!tp || (tp.direction !== "long" && tp.direction !== "short")) return null;
  // assets.tradable is a JSON SodexTradable ({symbol, market, …}) or NULL.
  const row = await get<{ tradable: string | null }>(
    `SELECT tradable FROM assets WHERE id = ? OR symbol = ? LIMIT 1`,
    [tp.asset_id ?? "", tp.asset_symbol ?? ""],
  );
  if (!row?.tradable) return null;
  try {
    return (JSON.parse(row.tradable) as { symbol?: string }).symbol ?? null;
  } catch {
    return null;
  }
}

function buildWealth(funds: Catalog) {
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
  return {
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
}

async function computeHome() {
  const now = Date.now();
  // Only FRESH pending signals: within their horizon AND (for event-driven
  // signals) fired in the last 48h — a catalyst older than that is stale news.
  const fresh48 = now - 48 * 60 * 60 * 1000;

  // All independent reads in parallel (was 6 sequential awaits + an external
  // HTTP call, which summed to ~10s on a cold instance).
  const [sigStats, topSignals, funds, briefing, graded, counts] =
    await Promise.all([
      get<SigStats>(
        // COALESCE the SUMs — with zero pending rows a bare SUM returns NULL.
        `SELECT
           COUNT(*) AS total_pending,
           COALESCE(SUM(CASE WHEN tier = 'auto' THEN 1 ELSE 0 END), 0) AS auto,
           COALESCE(SUM(CASE WHEN tier = 'review' THEN 1 ELSE 0 END), 0) AS review,
           COALESCE(SUM(CASE WHEN tier = 'info' THEN 1 ELSE 0 END), 0) AS info,
           AVG(confidence) AS avg_conf
         FROM signals
         WHERE status = 'pending'`,
      ),
      all<TopSig>(
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
      ),
      safeCatalog(),
      Briefings.getLatestBriefing(),
      // Calibration reads the LIVE grader (signal_outcomes), not impact_metrics.
      Postmortem.gradedOutcomeStats(30 * 24 * 60 * 60 * 1000),
      get<Counts>(
        `SELECT
           (SELECT COUNT(*) FROM news_events)          AS total_events,
           (SELECT COUNT(*) FROM classifications)      AS total_classified,
           (SELECT COUNT(*) FROM signals)              AS total_signals,
           (SELECT COUNT(*) FROM briefings)            AS total_briefings,
           (SELECT MAX(release_time) FROM news_events) AS last_event_at`,
      ),
    ]);

  // Dependent reads (need the results above) — also run together.
  const [recentGraded, topPickSodex] = await Promise.all([
    // Fallback for the Top-signals card when nothing is live: the 3 most
    // recently graded signals with their actual outcome.
    topSignals.length === 0
      ? Postmortem.recentGradedOutcomes(3)
      : Promise.resolve([] as Awaited<ReturnType<typeof Postmortem.recentGradedOutcomes>>),
    resolveTopPickSodex(briefing),
  ]);

  return {
    counts,
    signal_stats: sigStats,
    top_signals: topSignals,
    recent_graded: recentGraded,
    wealth: buildWealth(funds),
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
  };
}

async function storeHome(payload: unknown): Promise<void> {
  await run(
    `INSERT INTO kv_cache (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [CACHE_KEY, JSON.stringify(payload), Date.now()],
  );
}

export async function GET() {
  // Stale-while-revalidate off kv_cache.
  const cached = await get<{ value: string; updated_at: number }>(
    `SELECT value, updated_at FROM kv_cache WHERE key = ?`,
    [CACHE_KEY],
  );
  if (cached) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(cached.value);
    } catch {
      parsed = null;
    }
    if (parsed) {
      const age = Date.now() - Number(cached.updated_at);
      // Not fresh → refresh in the background, but still serve the cached copy
      // now so the dashboard never waits on the recompute.
      if (age >= FRESH_MS) {
        after(async () => {
          try {
            await storeHome(await computeHome());
          } catch {
            /* keep last good */
          }
        });
      }
      return NextResponse.json(parsed);
    }
  }

  // Cold / empty cache: compute now, serve, and persist for everyone next.
  const payload = await computeHome();
  after(async () => {
    try {
      await storeHome(payload);
    } catch {
      /* best effort */
    }
  });
  return NextResponse.json(payload);
}
