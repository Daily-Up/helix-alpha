/**
 * Daily AI Briefing service.
 *
 *   1. gatherBriefingInputs() — pure SQL aggregation across all data
 *      sources (signals, classifications, sectors, ETF, AlphaIndex,
 *      macro, /learnings).
 *   2. runBriefing() — call Claude with the inputs, persist the result.
 *
 * Idempotent on the UTC date: re-running the cron same-day overwrites
 * the prior briefing.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  Briefings,
  IndexFund,
  Macro,
  Postmortem,
  Settings,
  Treasuries,
  db,
  type BriefingInputsSummary,
  type Regime,
  type TopPick,
  type WatchlistEntry,
} from "@/lib/db";
import { Assets } from "@/lib/db";
import { Market } from "@/lib/sodex";
import { anthropic, getModel } from "./client";
import {
  BRIEFING_PROMPT_VERSION,
  briefingSystemPrompt,
  briefingTool,
  briefingUserMessage,
  type BriefingInputs,
} from "./prompts/briefing";

/** Anthropic Sonnet 4.5 pricing (USD per 1M tokens). Mirrored from
 *  the news ingest module so cost surfaces consistently. */
const PRICING = { input: 3, cached: 0.3, output: 15 };

const ToolInputSchema = z.object({
  headline: z.string().min(1),
  regime: z.enum(["risk_on", "risk_off", "mixed", "neutral"]),
  body: z.string().min(1),
  top_pick: z
    .object({
      asset_id: z.string(),
      asset_symbol: z.string(),
      direction: z.enum(["long", "short", "watch"]),
      thesis: z.string(),
      conviction: z.number().min(0).max(1),
    })
    .nullish(),
  watchlist: z
    .array(
      z.object({
        asset_id: z.string(),
        symbol: z.string(),
        note: z.string(),
      }),
    )
    .default([]),
});

// ─────────────────────────────────────────────────────────────────────────
// Inputs gathering
// ─────────────────────────────────────────────────────────────────────────

/** Build the structured snapshot the briefing prompt consumes. Pure SQL
 *  + a single live SoDEX ticker call. No Claude. */
export async function gatherBriefingInputs(opts: {
  date: string;
}): Promise<{ inputs: BriefingInputs; summary: BriefingInputsSummary }> {
  const conn = db();
  const now = Date.now();
  const last24h = now - 24 * 60 * 60 * 1000;

  // ── Pending signals (top 10 by conviction) ───────────────────
  interface PSRow {
    asset_symbol: string;
    direction: "long" | "short";
    tier: "auto" | "review" | "info";
    confidence: number;
    event_type: string | null;
    event_title: string | null;
    fired_at: number;
    reasoning: string;
  }
  const pendingRows = conn
    .prepare<[], PSRow>(
      `SELECT a.symbol AS asset_symbol, s.direction, s.tier, s.confidence,
              c.event_type, n.title AS event_title, s.fired_at, s.reasoning
       FROM signals s
       JOIN assets a ON a.id = s.asset_id
       LEFT JOIN news_events n ON n.id = s.triggered_by_event_id
       LEFT JOIN classifications c ON c.event_id = s.triggered_by_event_id
       WHERE s.status = 'pending'
       ORDER BY s.confidence DESC, s.fired_at DESC
       LIMIT 10`,
    )
    .all();

  const pending_signals = pendingRows.map((r) => ({
    asset_symbol: r.asset_symbol,
    direction: r.direction,
    tier: r.tier,
    confidence: r.confidence,
    event_type: r.event_type ?? "unknown",
    event_title: r.event_title ?? "(no title)",
    fired_at_iso: new Date(r.fired_at).toISOString(),
    reasoning_snippet: (r.reasoning ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200),
  }));

  // ── Recent classifications grouped by event_type (last 24h) ───
  interface ClassBucket {
    event_type: string;
    n: number;
    example_title: string;
  }
  const classBuckets = conn
    .prepare<[number, number], ClassBucket>(
      `SELECT c.event_type AS event_type, COUNT(*) AS n,
              (SELECT n2.title FROM news_events n2
               JOIN classifications c2 ON c2.event_id = n2.id
               WHERE c2.event_type = c.event_type AND n2.release_time >= ?
               ORDER BY n2.release_time DESC LIMIT 1) AS example_title
       FROM classifications c
       JOIN news_events n ON n.id = c.event_id
       WHERE n.release_time >= ?
         AND n.duplicate_of IS NULL
         AND c.actionable = 1
       GROUP BY c.event_type
       ORDER BY n DESC
       LIMIT 8`,
    )
    .all(last24h, last24h);

  const recent_classification_buckets = classBuckets.map((b) => ({
    event_type: b.event_type,
    n: b.n,
    example_title: b.example_title ?? "",
  }));

  // ── AlphaIndex top 5 positions, marked-to-market ──────────────
  const indexId = "alphacore";
  const idx = IndexFund.getIndex(indexId);
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

  const positions = IndexFund.listPositions(indexId);
  let invested = 0;
  const positionViews: Array<{
    symbol: string;
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
      weight_pct: 0, // filled below
      pnl_pct,
      rationale: p.rationale,
      value,
    });
  }
  const lastNav = IndexFund.listNavHistory(indexId, 1)[0];
  const navTotal = lastNav?.nav_usd ?? idx?.starting_nav ?? 0;
  const cash = Math.max(0, navTotal - invested);
  const totalNav = invested + cash;
  for (const p of positionViews) {
    p.weight_pct = totalNav > 0 ? (p.value / totalNav) * 100 : 0;
  }
  positionViews.sort((a, b) => b.value - a.value);
  const alphaindex_positions = positionViews.slice(0, 5).map((p) => ({
    symbol: p.symbol,
    weight_pct: p.weight_pct,
    pnl_pct: p.pnl_pct,
    rationale: p.rationale,
  }));
  const alphaindex_nav = {
    total: totalNav,
    pnl_pct:
      idx && idx.starting_nav > 0
        ? ((totalNav - idx.starting_nav) / idx.starting_nav) * 100
        : 0,
  };

  // ── Sectors top/bottom 3 (from sector_snapshots — latest snapshot) ──
  interface SectorRow {
    sector_name: string;
    change_pct_24h: number;
    marketcap_dom: number;
  }
  const sectorsAll = conn
    .prepare<[], SectorRow>(
      `SELECT sector_name, change_pct_24h, marketcap_dom
       FROM sector_snapshots
       WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM sector_snapshots)`,
    )
    .all();
  const sectorsSorted = [...sectorsAll].sort(
    (a, b) => b.change_pct_24h - a.change_pct_24h,
  );
  const sectors_top = sectorsSorted.slice(0, 3).map((s) => ({
    name: s.sector_name,
    change_24h_pct: s.change_pct_24h * 100,
    market_cap_dom: s.marketcap_dom,
  }));
  const sectors_bottom = sectorsSorted
    .slice(-3)
    .reverse()
    .map((s) => ({
      name: s.sector_name,
      change_24h_pct: s.change_pct_24h * 100,
      market_cap_dom: s.marketcap_dom,
    }));

  // ── ETF flows last 24h (aggregate by symbol on the latest day) ──
  interface ETFRow {
    symbol: string;
    net_flow_usd: number;
  }
  const etfRows = conn
    .prepare<[], ETFRow>(
      `SELECT symbol,
              SUM(total_net_inflow) AS net_flow_usd
       FROM etf_aggregate_daily
       WHERE date = (SELECT MAX(date) FROM etf_aggregate_daily)
       GROUP BY symbol
       ORDER BY ABS(SUM(total_net_inflow)) DESC
       LIMIT 8`,
    )
    .all();
  const etf_flows_24h = etfRows.filter(
    (e) => Number.isFinite(e.net_flow_usd),
  );

  // ── Upcoming macro (next 24h, from macro_calendar) ──────────────
  // The schema is just (date TEXT, event TEXT) — store today and
  // tomorrow's events; "next 24h" precision isn't possible without
  // hour-of-day data, so we approximate.
  interface MacroRow {
    date: string;
    event: string;
  }
  const todayDate = new Date(now).toISOString().slice(0, 10);
  const tomorrowDate = new Date(now + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const macroRows = conn
    .prepare<[string, string], MacroRow>(
      `SELECT date, event FROM macro_calendar
       WHERE date IN (?, ?)
       ORDER BY date ASC
       LIMIT 5`,
    )
    .all(todayDate, tomorrowDate);
  const upcoming_macro = macroRows.map((m) => ({
    name: m.event,
    release_time_iso: m.date, // YYYY-MM-DD; precise time unknown
  }));

  // ── Calibration: best-performing event_type from /learnings ────
  const byEventType = Postmortem.statsByEventType({
    since_ms: 30 * 24 * 60 * 60 * 1000,
  });
  const evaluable = byEventType.filter(
    (r) => r.count >= 2 && r.hit_rate_3d != null,
  );
  evaluable.sort((a, b) => (b.hit_rate_3d ?? 0) - (a.hit_rate_3d ?? 0));
  const best = evaluable[0];
  const best_calibrated_event_type = best
    ? {
        event_type: best.key,
        hit_rate_3d: best.hit_rate_3d!,
        n: best.count,
      }
    : null;

  // ── Corporate BTC treasury accumulation (last 30d) ────────────
  // The /btc-treasuries/{ticker}/purchase-history surface — concrete,
  // dated, named-quantity smart-money signals. Massive value for the
  // briefing because it's HARD FACT, unlike news that's already
  // chewed by the time signals fire.
  const recentPurchases = Treasuries.listRecentPurchases({
    daysBack: 30,
    limit: 12,
  });
  const treasury_purchases_30d = recentPurchases.map((p) => ({
    date: p.date,
    ticker: p.ticker,
    company_name: p.company_name ?? p.ticker,
    btc_acq: p.btc_acq,
    btc_holding: p.btc_holding,
    acq_cost_usd: p.acq_cost_usd,
    cost_per_btc_usd: p.avg_btc_cost_usd,
  }));
  const treasuryAgg = Treasuries.getAggregateStats(30);
  const treasury_stats_30d = {
    acquiring_companies: treasuryAgg.acquiring_companies_30d,
    net_btc_acquired: treasuryAgg.net_btc_acquired_30d,
    total_acq_cost_usd: treasuryAgg.total_acq_cost_30d_usd,
    total_btc_held_latest: treasuryAgg.total_btc_held_latest,
  };

  // ── Macro print surprises (last 60d, top |actual - forecast|) ──
  // Hard, dated forecast misses — cooler-than-expected CPI is a real
  // tradeable input for the briefing's macro regime call.
  const surpriseRows = Macro.listRecentSurprises({
    daysBack: 60,
    limit: 6,
    requireForecast: true,
  });
  const macro_surprises_60d = surpriseRows
    .filter(
      (r) =>
        r.surprise != null && r.actual_raw != null && r.forecast_raw != null,
    )
    .map((r) => ({
      date: r.date,
      event: r.event,
      actual: r.actual_raw!,
      forecast: r.forecast_raw!,
      surprise: r.surprise!,
      unit: r.unit,
    }));

  const inputs: BriefingInputs = {
    date: opts.date,
    pending_signals,
    recent_classification_buckets,
    alphaindex_positions,
    alphaindex_nav,
    sectors_top,
    sectors_bottom,
    etf_flows_24h,
    upcoming_macro,
    best_calibrated_event_type,
    treasury_purchases_30d,
    treasury_stats_30d,
    macro_surprises_60d,
  };

  const summary: BriefingInputsSummary = {
    pending_signals: pending_signals.length,
    classifications_24h: recent_classification_buckets.reduce(
      (a, b) => a + b.n,
      0,
    ),
    top_event_types: recent_classification_buckets.slice(0, 5).map((b) => ({
      event_type: b.event_type,
      n: b.n,
    })),
    alphaindex_top_positions: alphaindex_positions.map((p) => ({
      symbol: p.symbol,
      weight_pct: p.weight_pct,
    })),
    sector_top: sectors_top.map((s) => ({
      name: s.name,
      change_24h_pct: s.change_24h_pct,
    })),
    sector_bottom: sectors_bottom.map((s) => ({
      name: s.name,
      change_24h_pct: s.change_24h_pct,
    })),
    etf_net_flow_24h_usd:
      etf_flows_24h.length > 0
        ? etf_flows_24h.reduce((a, e) => a + e.net_flow_usd, 0)
        : null,
    best_event_type_hit_rate: best_calibrated_event_type
      ? {
          event_type: best_calibrated_event_type.event_type,
          hit_rate_3d: best_calibrated_event_type.hit_rate_3d,
          n: best_calibrated_event_type.n,
        }
      : null,
    treasury_summary: treasury_stats_30d.acquiring_companies > 0
      ? treasury_stats_30d
      : null,
  };

  return { inputs, summary };
}

// ─────────────────────────────────────────────────────────────────────────
// Run + persist
// ─────────────────────────────────────────────────────────────────────────

export interface BriefingRunResult {
  date: string;
  cached: boolean;
  cost_usd: number;
  tokens: { input: number; output: number; cached: number };
  latency_ms: number;
}

/** Generate today's briefing (or any explicit date) and persist it.
 *  Idempotent: if a briefing already exists for `date` and force=false,
 *  returns immediately without paying for a fresh Claude call. */
export async function runBriefing(opts: {
  date?: string;
  force?: boolean;
} = {}): Promise<BriefingRunResult> {
  const t0 = Date.now();
  const date = opts.date ?? Briefings.todayUtcDate();

  if (!opts.force) {
    const existing = Briefings.getBriefing(date);
    if (existing) {
      return {
        date,
        cached: true,
        cost_usd: 0,
        tokens: { input: 0, output: 0, cached: 0 },
        latency_ms: Date.now() - t0,
      };
    }
  }

  const { inputs, summary } = await gatherBriefingInputs({ date });
  const userMsg = briefingUserMessage(inputs);
  const sys = briefingSystemPrompt();

  const client = anthropic();
  const model = getModel();
  const tool = briefingTool();

  const resp = await client.messages.create({
    model,
    max_tokens: 1500,
    system: sys,
    tools: [tool],
    tool_choice: { type: "tool", name: "publish_daily_briefing" },
    messages: [userMsg],
  });

  const toolUse = resp.content.find(
    (b: Anthropic.Messages.ContentBlock) => b.type === "tool_use",
  ) as Extract<Anthropic.Messages.ContentBlock, { type: "tool_use" }> | undefined;
  if (!toolUse) {
    throw new Error("Briefing call returned no tool use");
  }

  const parsed = ToolInputSchema.parse(toolUse.input);

  const usage = resp.usage;
  const tokens = {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cached:
      (usage as unknown as { cache_read_input_tokens?: number })
        .cache_read_input_tokens ?? 0,
  };
  const cost_usd =
    (tokens.input * PRICING.input +
      tokens.cached * PRICING.cached +
      tokens.output * PRICING.output) /
    1_000_000;

  Briefings.upsertBriefing({
    date,
    generated_at: Date.now(),
    headline: parsed.headline,
    regime: parsed.regime as Regime,
    body: parsed.body,
    top_pick: (parsed.top_pick as TopPick | null | undefined) ?? null,
    watchlist: (parsed.watchlist as WatchlistEntry[]) ?? [],
    inputs_summary: summary,
    model,
    prompt_version: BRIEFING_PROMPT_VERSION,
    tokens_input: tokens.input,
    tokens_output: tokens.output,
    tokens_cached: tokens.cached,
    cost_usd,
  });

  // Briefly mark the cron's "review with claude" preference unchanged —
  // we don't modify settings here. The settings reference is for parity
  // with how /briefing is rendered.
  void Settings.getSettings;

  return {
    date,
    cached: false,
    cost_usd,
    tokens,
    latency_ms: Date.now() - t0,
  };
}
