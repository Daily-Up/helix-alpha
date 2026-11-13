/**
 * Home dashboard snapshot — the payload behind GET /api/data/home.
 *
 * It's heavy (several DB reads + the external SoDEX Wealth catalog), so the
 * independent reads run in PARALLEL and the assembled payload is cached in
 * kv_cache. The route serves the cache with stale-while-revalidate, and the
 * 5-min `tick` pipeline pre-warms it (refreshHomeSnapshot) so the dashboard is
 * always an instant cache read — never a cold ~10s compute.
 */

import { Briefings, Postmortem, all, get, run } from "@/lib/db";
import { fetchCatalog } from "@/lib/wealth/client";

export const HOME_CACHE_KEY = "home_snapshot";
/** Serve a cached snapshot with no refresh if it's younger than this. */
export const HOME_FRESH_MS = 60_000;

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

/** Compute the full dashboard payload (parallelized). */
export async function computeHomeSnapshot() {
  const now = Date.now();
  // Only FRESH pending signals: within their horizon AND (for event-driven
  // signals) fired in the last 48h — a catalyst older than that is stale news.
  const fresh48 = now - 48 * 60 * 60 * 1000;

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

  const [recentGraded, topPickSodex] = await Promise.all([
    // Fallback for the Top-signals card when nothing is live: the 3 most
    // recently graded signals with their actual outcome.
    topSignals.length === 0
      ? Postmortem.recentGradedOutcomes(3)
      : Promise.resolve(
          [] as Awaited<ReturnType<typeof Postmortem.recentGradedOutcomes>>,
        ),
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

/** Write a computed payload into kv_cache. */
export async function storeHomeSnapshot(payload: unknown): Promise<void> {
  await run(
    `INSERT INTO kv_cache (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [HOME_CACHE_KEY, JSON.stringify(payload), Date.now()],
  );
}

/** Read the cached payload + its age, or null if absent/corrupt. */
export async function readHomeSnapshot(): Promise<{
  payload: unknown;
  as_of: number;
} | null> {
  const row = await get<{ value: string; updated_at: number }>(
    `SELECT value, updated_at FROM kv_cache WHERE key = ?`,
    [HOME_CACHE_KEY],
  );
  if (!row) return null;
  try {
    return { payload: JSON.parse(row.value), as_of: Number(row.updated_at) };
  } catch {
    return null;
  }
}

/** Compute + store — called by the 5-min tick to keep the cache always warm. */
export async function refreshHomeSnapshot(): Promise<{
  pending: number;
  events: number;
}> {
  const payload = await computeHomeSnapshot();
  await storeHomeSnapshot(payload);
  return {
    pending: payload.signal_stats?.total_pending ?? 0,
    events: payload.counts?.total_events ?? 0,
  };
}
