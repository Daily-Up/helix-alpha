/**
 * Wealth Index suggestion engine.
 *
 * Factual, input-grounded "here's what you can do" cards. Rules:
 *   • Event cards are driven by Helix's CLASSIFIED events matched to a fund's
 *     actual underlying by ASSET ID (not keywords): QQQ ↔ Nasdaq-100
 *     constituents + index, SMH ↔ semiconductor names, VOO ↔ S&P 500/index,
 *     etc. Require ≥2 relevant events at confidence ≥0.6; dedupe near-identical
 *     headlines (duplicate_of + title similarity) like the Event Stream. Funds
 *     with no Helix-tracked underlying (CXMT, Unitree) fall back to SoDEX's
 *     per-fund news feed.
 *   • Card wording: a sentiment summary + the top driver — e.g. "US Semis 25:
 *     3 bullish events in 48h; biggest: AMD shares up 7.3%." Factual, no
 *     directives.
 *   • Efficiency is the always-on baseline: idle USDC vs USDC Earn APY, and a
 *     yield-gap when a similar-risk Stable Earn pays ≥0.5pp more than one the
 *     user holds.
 *   • Risk is a guardrail: concentration context is attached (not standalone)
 *     only when a fund is ≥30% of the wealth book; event cards are suppressed
 *     when ≥50%.
 *   • Ranking: max 4 cards, ≤2 event cards, ≥1 efficiency card when applicable.
 *     Rank by holdings first, then severity × confidence.
 *   • No invented numbers; every number is in `inputs` with its timestamp. The
 *     UI renders "Not financial advice" on every card.
 */

import { all } from "@/lib/db";
import { fetchFundNews, type WealthNewsItem } from "./client";
import type {
  WealthFundView,
  WealthPortfolio,
  WealthSuggestion,
} from "./types";

const DAY = 24 * 60 * 60 * 1000;
const SODEX_WEALTH_URL = "https://sodex.com/wealth";
const MIN_IDLE_USDC = 10;
const YIELD_GAP_PP = 0.5;
const CONCENTRATION_FLAG_PCT = 30;
const CONCENTRATION_SUPPRESS_PCT = 50;
const MIN_EVENT_CONFIDENCE = 0.6;
const MIN_EVENTS_FOR_CARD = 2;

/**
 * Each fund → the Helix asset_ids that ARE its underlying. Event cards fire
 * only when a classified event's affected assets intersect this set. Funds not
 * listed (dividend baskets, CXMT, Unitree) have no Helix-tracked underlying and
 * get no Helix-event card (CXMT/Unitree use SoDEX news instead).
 */
const MEGA_CAP_TECH = [
  "stk-aapl", "stk-msft", "stk-nvda", "stk-googl", "stk-amzn", "stk-meta",
  "stk-tsla", "stk-amd", "stk-intc", "stk-mu", "stk-orcl", "stk-pltr", "stk-tsm",
];
const SEMIS = ["stk-nvda", "stk-amd", "stk-intc", "stk-mu", "stk-tsm"];
const RATE_MACRO = [
  "mac-fomc", "mac-cpi", "mac-core-cpi", "mac-nonfarm-payrolls", "mac-ppi",
  "mac-ism-manufacturing-pmi", "mac-ism-non-manufacturing-pmi",
];
const FUND_UNDERLYING: Record<string, string[]> = {
  vQQQ: ["perp-ustech100", "idx-ssimag7", ...MEGA_CAP_TECH],
  vVGT: ["perp-ustech100", "idx-ssimag7", ...MEGA_CAP_TECH],
  vVOO: ["perp-us500", "idx-ssimag7"], // S&P 500 / index-level only (too broad for constituents)
  vSMH: SEMIS,
  vSTRC: ["trs-mstr"],
  "Morpho-Earn": RATE_MACRO,
  vBOXX: RATE_MACRO,
};

const pct = (n: number | null) =>
  n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const usd = (n: number | null) =>
  n == null ? "—" : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string | null) =>
  iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z" : "unknown";

type Sent = "positive" | "negative" | "neutral";
const SENT_WORD: Record<Sent, string> = {
  positive: "bullish",
  negative: "bearish",
  neutral: "neutral",
};
const SEVERITY_WEIGHT: Record<string, number> = { high: 3, medium: 2, low: 1 };

interface ClassifiedEvent {
  id: string;
  release_time: number;
  title: string;
  href: string | null;
  sentiment: Sent;
  severity: string;
  confidence: number;
  assetIds: string[];
  score: number; // severity × confidence
}

/** Recent canonical classified events (deduped by duplicate_of, conf ≥ 0.6). */
async function fetchClassifiedEvents(sinceMs: number): Promise<ClassifiedEvent[]> {
  const rows = await all<{
    id: string;
    release_time: number;
    title: string;
    source_link: string | null;
    original_link: string | null;
    sentiment: Sent;
    severity: string;
    confidence: number;
    affected_asset_ids: string | null;
  }>(
    `SELECT n.id, n.release_time, n.title, n.source_link, n.original_link,
            c.sentiment, c.severity, c.confidence, c.affected_asset_ids
     FROM news_events n
     JOIN classifications c ON c.event_id = n.id
     LEFT JOIN skipped_pre_classify s ON s.id = n.id
     WHERE n.duplicate_of IS NULL AND s.id IS NULL
       AND n.release_time >= ?
       AND c.confidence >= ?
     ORDER BY n.release_time DESC
     LIMIT 400`,
    [sinceMs, MIN_EVENT_CONFIDENCE],
  );
  return rows.map((r) => {
    let assetIds: string[] = [];
    try {
      assetIds = r.affected_asset_ids ? (JSON.parse(r.affected_asset_ids) as string[]) : [];
    } catch {
      assetIds = [];
    }
    return {
      id: r.id,
      release_time: r.release_time,
      title: cleanTitle(r.title),
      href: r.original_link || r.source_link || "/events",
      sentiment: r.sentiment,
      severity: r.severity,
      confidence: r.confidence,
      assetIds,
      score: (SEVERITY_WEIGHT[r.severity] ?? 1) * r.confidence,
    };
  });
}

function cleanTitle(t: string): string {
  return t.replace(/^(Express News|Flash|BREAKING|QUICK SPARK)\s*[|:]\s*/i, "").trim();
}

// ── Near-identical-headline dedup (token-set Jaccard) ──────────────────
function tokens(t: string): Set<string> {
  return new Set(
    t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3),
  );
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
/** Collapse near-duplicate headlines, keeping the highest-scoring one. */
function dedupeEvents(events: ClassifiedEvent[]): ClassifiedEvent[] {
  const sorted = [...events].sort((a, b) => b.score - a.score);
  const kept: Array<{ e: ClassifiedEvent; tok: Set<string> }> = [];
  for (const e of sorted) {
    const tk = tokens(e.title);
    if (kept.some((k) => jaccard(k.tok, tk) >= 0.6)) continue;
    kept.push({ e, tok: tk });
  }
  return kept.map((k) => k.e);
}

function concentrationPct(portfolio: WealthPortfolio | null, fundId: string): number | null {
  if (!portfolio || !portfolio.totalWealth || portfolio.totalWealth <= 0) return null;
  const pos = portfolio.positions.find((p) => p.fundId === fundId);
  if (!pos || pos.marketValue == null) return null;
  return (pos.marketValue / portfolio.totalWealth) * 100;
}
function isHeld(portfolio: WealthPortfolio | null, fundId: string): boolean {
  return !!portfolio?.positions.some((p) => p.fundId === fundId && (p.marketValue ?? 0) > 0.01);
}

// ── Efficiency baseline ────────────────────────────────────────────────

function idleUsdcCard(
  catalog: WealthFundView[],
  idleUsdc: number | null,
  asOfBalance: string | null,
): WealthSuggestion | null {
  if (idleUsdc == null || idleUsdc < MIN_IDLE_USDC) return null;
  const earn = catalog.find((f) => f.fundId === "Morpho-Earn");
  if (!earn || earn.apy7d == null) return null;
  return {
    id: "eff-idle-usdc",
    kind: "efficiency",
    fundId: earn.fundId,
    observation: `You have ${usd(idleUsdc)} in available SoDEX spot USDC that isn't in a yield product.`,
    option: `${earn.displayName}'s current 7-day APY is ${pct(earn.apy7d)}, and it's redeemable anytime.`,
    inputs: [
      `Spot USDC available: ${usd(idleUsdc)} (as of ${when(asOfBalance)})`,
      `${earn.displayName} 7D APY: ${pct(earn.apy7d)} (as of ${when(earn.asOf)})`,
    ],
    sources: [],
    riskNote: null,
    asOf: earn.asOf ?? asOfBalance ?? new Date().toISOString(),
    relevance: 80,
    ctaLabel: `View ${earn.displayName} on SoDEX`,
    ctaHref: SODEX_WEALTH_URL,
  };
}

function redemptionNote(f: WealthFundView): string {
  if (f.fundId === "Morpho-Earn") return "redeemable anytime";
  if (f.marketStatus) return `follows market hours (currently ${f.marketStatus})`;
  return "see SoDEX for redemption terms";
}

/** Yield gap: a Stable Earn pays ≥0.5pp more than a Stable Earn the user holds. */
function yieldGapCard(
  catalog: WealthFundView[],
  portfolio: WealthPortfolio | null,
): WealthSuggestion | null {
  const stable = catalog.filter((f) => f.category === "stable_earn" && f.apy7d != null);
  const held = stable.filter((f) => isHeld(portfolio, f.fundId));
  if (held.length === 0) return null;
  // Lowest-yielding held product vs the highest-yielding Stable Earn overall.
  const heldLow = [...held].sort((a, b) => (a.apy7d ?? 0) - (b.apy7d ?? 0))[0];
  const best = [...stable].sort((a, b) => (b.apy7d ?? 0) - (a.apy7d ?? 0))[0];
  if (best.fundId === heldLow.fundId) return null;
  const gap = (best.apy7d ?? 0) - (heldLow.apy7d ?? 0);
  if (gap < YIELD_GAP_PP) return null;
  return {
    id: "eff-yield-gap",
    kind: "yield_rotation",
    fundId: best.fundId,
    observation: `${best.displayName}'s 7-day APY (${pct(best.apy7d)}) is ${gap.toFixed(2)} points higher than ${heldLow.displayName}'s (${pct(heldLow.apy7d)}), which you hold.`,
    option: `Both are Stable Earn. ${heldLow.displayName} ${redemptionNote(heldLow)}; ${best.displayName} ${redemptionNote(best)}.`,
    inputs: [
      `${best.displayName} 7D APY: ${pct(best.apy7d)} (as of ${when(best.asOf)})`,
      `${heldLow.displayName} 7D APY: ${pct(heldLow.apy7d)} (as of ${when(heldLow.asOf)})`,
      `Difference: ${gap.toFixed(2)} points`,
    ],
    sources: [],
    riskNote: null,
    asOf: best.asOf ?? new Date().toISOString(),
    relevance: 70,
    ctaLabel: "Compare on SoDEX",
    ctaHref: SODEX_WEALTH_URL,
  };
}

// ── Event cards ─────────────────────────────────────────────────────────

function sentimentSummary(events: ClassifiedEvent[]): string {
  const counts: Record<Sent, number> = { positive: 0, negative: 0, neutral: 0 };
  for (const e of events) counts[e.sentiment]++;
  const parts: string[] = [];
  (["negative", "positive", "neutral"] as Sent[]).forEach((s) => {
    if (counts[s] > 0) parts.push(`${counts[s]} ${SENT_WORD[s]}`);
  });
  return parts.join(", ");
}

function helixEventCard(
  fund: WealthFundView,
  events: ClassifiedEvent[],
  portfolio: WealthPortfolio | null,
): WealthSuggestion | null {
  const deduped = dedupeEvents(events);
  if (deduped.length < MIN_EVENTS_FOR_CARD) return null;

  const conc = concentrationPct(portfolio, fund.fundId);
  if (conc != null && conc >= CONCENTRATION_SUPPRESS_PCT) return null; // guardrail

  const top = [...deduped].sort((a, b) => b.score - a.score)[0];
  const summary = sentimentSummary(deduped);
  const held = isHeld(portfolio, fund.fundId);
  const newest = Math.max(...deduped.map((e) => e.release_time));

  const inputs = [
    `Relevant Helix events (48h, conf ≥ 60%): ${deduped.length} — ${summary}`,
    `Top driver: ${top.title.slice(0, 90)} (${SENT_WORD[top.sentiment]}, ${top.severity}, conf ${(top.confidence * 100).toFixed(0)}%)`,
  ];
  if (fund.changePct != null) inputs.push(`${fund.symbol} 24h: ${pct(fund.changePct)} (as of ${when(fund.asOf)})`);
  else if (fund.headlineValue != null) inputs.push(`${fund.headlineLabel}: ${pct(fund.headlineValue)}`);

  let riskNote: string | null = null;
  if (conc != null && conc >= CONCENTRATION_FLAG_PCT) {
    riskNote = `${fund.displayName} is already ${conc.toFixed(1)}% of your wealth book.`;
  }

  const sumScore = deduped.reduce((s, e) => s + e.score, 0);
  const relevance = (held ? 1000 : 0) + Math.round(sumScore * 10);

  return {
    id: `evt-${fund.fundId}`,
    kind: "event",
    fundId: fund.fundId,
    observation: `${fund.displayName}: ${summary} event${deduped.length === 1 ? "" : "s"} in 48h; biggest: ${top.title.slice(0, 70)}.`,
    option:
      fund.changePct != null
        ? `${fund.displayName} is ${pct(fund.changePct)} over 24h${fund.roi1M != null ? `, ${pct(fund.roi1M)} over the past month` : ""}.`
        : `${fund.displayName}'s ${fund.headlineLabel.toLowerCase()} is ${pct(fund.headlineValue)}.`,
    inputs,
    sources: deduped.slice(0, 3).map((e) => ({
      label: `${SENT_WORD[e.sentiment]} · ${e.title.slice(0, 70)}`,
      href: e.href ?? undefined,
      ts: new Date(e.release_time).toISOString(),
    })),
    riskNote,
    asOf: new Date(newest).toISOString(),
    relevance,
    ctaLabel: `View ${fund.displayName} on SoDEX`,
    ctaHref: SODEX_WEALTH_URL,
  };
}

/** SoDEX per-fund news card — only for funds with no Helix-tracked underlying. */
function newsCard(
  fund: WealthFundView,
  news: WealthNewsItem[],
  portfolio: WealthPortfolio | null,
  now: number,
): WealthSuggestion | null {
  const recent = news.filter((n) => n.ts && now - Date.parse(n.ts) <= 2 * DAY);
  if (recent.length < MIN_EVENTS_FOR_CARD) return null;

  const conc = concentrationPct(portfolio, fund.fundId);
  if (conc != null && conc >= CONCENTRATION_SUPPRESS_PCT) return null;

  const bull = recent.filter((n) => n.sentiment === "Bullish").length;
  const bear = recent.filter((n) => n.sentiment === "Bearish").length;
  const sentBits = [bull ? `${bull} bullish` : "", bear ? `${bear} bearish` : ""].filter(Boolean).join(", ");
  const top = recent[0];
  const held = isHeld(portfolio, fund.fundId);
  const newest = Math.max(...recent.map((n) => (n.ts ? Date.parse(n.ts) : 0)));

  const inputs = [`SoDEX news items (48h): ${recent.length}${sentBits ? ` — ${sentBits}` : ""}`];
  if (fund.changePct != null) inputs.push(`${fund.symbol} 24h: ${pct(fund.changePct)} (as of ${when(fund.asOf)})`);
  if (fund.roi1M != null) inputs.push(`1-month: ${pct(fund.roi1M)}`);

  let riskNote: string | null = null;
  if (conc != null && conc >= CONCENTRATION_FLAG_PCT) {
    riskNote = `${fund.displayName} is already ${conc.toFixed(1)}% of your wealth book.`;
  }

  return {
    id: `news-${fund.fundId}`,
    kind: "event",
    fundId: fund.fundId,
    observation: `${fund.displayName}: ${recent.length} news items in 48h${sentBits ? ` (${sentBits})` : ""}; biggest: ${top.title.slice(0, 70)}.`,
    option:
      fund.changePct != null
        ? `${fund.displayName} is ${pct(fund.changePct)} over 24h${fund.roi1M != null ? `, ${pct(fund.roi1M)} over the past month` : ""}.`
        : `${fund.displayName}'s ${fund.headlineLabel.toLowerCase()} is ${pct(fund.headlineValue)}.`,
    inputs,
    sources: recent.slice(0, 3).map((n) => ({
      label: `${n.sentiment ? n.sentiment + " · " : ""}${n.title.slice(0, 70)}`,
      href: n.url ?? undefined,
      ts: n.ts ?? undefined,
    })),
    riskNote,
    asOf: newest > 0 ? new Date(newest).toISOString() : new Date().toISOString(),
    relevance: (held ? 1000 : 0) + recent.length * 4 + (bull + bear) * 3,
    ctaLabel: `View ${fund.displayName} on SoDEX`,
    ctaHref: SODEX_WEALTH_URL,
  };
}

// ── Orchestration ──────────────────────────────────────────────────────

export async function buildSuggestions(args: {
  catalog: WealthFundView[];
  portfolio: WealthPortfolio | null;
  idleUsdc: number | null;
  idleUsdcAsOf: string | null;
  now?: number;
}): Promise<WealthSuggestion[]> {
  const { catalog, portfolio, idleUsdc, idleUsdcAsOf } = args;
  const now = args.now ?? Date.now();
  const sinceMs = now - 2 * DAY;

  // Helix classified events (asset-tagged, deduped, conf ≥ 0.6).
  let events: ClassifiedEvent[] = [];
  try {
    events = await fetchClassifiedEvents(sinceMs);
  } catch {
    events = [];
  }

  // Event cards — one per fund with a Helix-tracked underlying.
  const eventCards: WealthSuggestion[] = [];
  for (const fund of catalog) {
    const underlying = FUND_UNDERLYING[fund.fundId];
    if (!underlying) continue;
    const set = new Set(underlying);
    const matched = events.filter((e) => e.assetIds.some((a) => set.has(a)));
    const card = helixEventCard(fund, matched, portfolio);
    if (card) eventCards.push(card);
  }

  // SoDEX-news cards — only for funds with no Helix underlying (CXMT, Unitree).
  const newsFunds = catalog.filter((f) => f.newsSeo && !FUND_UNDERLYING[f.fundId]);
  const newsResults = await Promise.all(
    newsFunds.map((f) => fetchFundNews(f.newsSeo as string, 30).then((n) => [f, n] as const)),
  );
  for (const [fund, news] of newsResults) {
    const card = newsCard(fund, news, portfolio, now);
    if (card) eventCards.push(card);
  }

  // Efficiency baseline.
  const effCards: WealthSuggestion[] = [];
  const idle = idleUsdcCard(catalog, idleUsdc, idleUsdcAsOf);
  if (idle) effCards.push(idle);
  const gap = yieldGapCard(catalog, portfolio);
  if (gap) effCards.push(gap);

  // Caps: ≤2 event cards (ranked: holdings first, then severity × confidence),
  // ≥1 efficiency when available, 4 total. Dedupe event cards that share their
  // top driver — the same AMD story shouldn't fill both the Nasdaq-100 and
  // broad-tech cards; keep the higher-ranked (held) fund.
  const seenTop = new Set<string>();
  const topEvents: WealthSuggestion[] = [];
  for (const c of eventCards.sort((a, b) => b.relevance - a.relevance)) {
    const topKey = c.sources[0]?.href || c.sources[0]?.label || c.id;
    if (seenTop.has(topKey)) continue;
    seenTop.add(topKey);
    topEvents.push(c);
    if (topEvents.length >= 2) break;
  }
  const combined = [...topEvents, ...effCards];
  combined.sort((a, b) => b.relevance - a.relevance);
  return combined.slice(0, 4);
}
