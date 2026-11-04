/**
 * Wealth Index suggestion engine.
 *
 * Produces factual, input-grounded "here's what you can do" cards. Rules
 * (from the product spec):
 *   • Events/news LEAD: a card about a fund fires when its underlying has
 *     recent notable news (SoDEX per-fund news) and/or matching Helix events.
 *     The triggering items are attached as linked sources.
 *   • Efficiency is the always-on BASELINE: idle USDC + the APY gap between
 *     similar-risk Stable Earn products — evaluated even when there's no news.
 *   • Risk is a GUARDRAIL, never a standalone card: concentration context is
 *     attached to other cards, and an event card is downgraded/suppressed when
 *     the fund is already a large share of the user's wealth book.
 *   • Strictly factual: observation states what's true, option states a thing
 *     the user COULD do — never a directive. Every number in the text also
 *     appears in `inputs` with its timestamp. If a datum is missing, no card.
 *   • Max 3–5 cards, ranked by relevance; each carries its asOf timestamp.
 *     ("Not financial advice" is rendered by the UI on every card.)
 */

import { Events } from "@/lib/db";
import { fetchFundNews, type WealthNewsItem } from "./client";
import type {
  WealthFundView,
  WealthPortfolio,
  WealthSuggestion,
} from "./types";

const DAY = 24 * 60 * 60 * 1000;
const SODEX_WEALTH_URL = "https://sodex.com/wealth";
const MIN_IDLE_USDC = 10; // SoDEX min subscription
const YIELD_GAP_PP = 0.25; // min APY gap to surface a rotation observation
const CONCENTRATION_SUPPRESS_PCT = 50;
const CONCENTRATION_FLAG_PCT = 40;

/** Keywords used to match Helix's own event stream to a fund's underlying. */
const FUND_KEYWORDS: Record<string, string[]> = {
  CXMT: ["cxmt", "changxin", "dram", "memory chip", "micron", "hbm"],
  UNITREE: ["unitree", "humanoid", "robotics", "robot"],
  vSMH: ["semiconductor", "chipmaker", "nvidia", "amd", "micron", "tsmc", "sk hynix"],
  vQQQ: ["nasdaq", "nasdaq-100", "big tech", "mega-cap tech"],
  vVGT: ["technology sector", "it sector"],
  vVOO: ["s&p 500", "s&p500", "sp500"],
  vSCHD: ["dividend"],
  vVYM: ["dividend"],
  vBOXX: ["treasury", "t-bill", "fed ", "interest rate", "rate cut", "rate hike"],
  "Morpho-Earn": ["treasury", "fed ", "interest rate", "rate cut", "rate hike", "stablecoin yield"],
};

const pct = (n: number | null) =>
  n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const usd = (n: number | null) =>
  n == null ? "—" : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string | null) =>
  iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z" : "unknown";

interface HelixMatch {
  id: string;
  title: string;
  href: string | null;
  ts: string;
}

/** Recent Helix events whose title/matched symbols hit a fund's keywords. */
function matchHelixEvents(
  events: Array<{
    id: string;
    title: string;
    release_time: number;
    original_link: string | null;
    source_link: string | null;
    matched_currencies: Array<{ symbol: string; name: string }>;
  }>,
  keywords: string[],
  now: number,
): HelixMatch[] {
  const kw = keywords.map((k) => k.toLowerCase());
  const out: HelixMatch[] = [];
  for (const e of events) {
    if (now - e.release_time > 2 * DAY) continue;
    const hay =
      (e.title || "").toLowerCase() +
      " " +
      e.matched_currencies.map((c) => `${c.symbol} ${c.name}`).join(" ").toLowerCase();
    if (kw.some((k) => hay.includes(k))) {
      out.push({
        id: e.id,
        title: e.title,
        href: e.original_link || e.source_link || `/events`,
        ts: new Date(e.release_time).toISOString(),
      });
    }
    if (out.length >= 3) break;
  }
  return out;
}

function concentrationPct(
  portfolio: WealthPortfolio | null,
  fundId: string,
): number | null {
  if (!portfolio || !portfolio.totalWealth || portfolio.totalWealth <= 0) return null;
  const pos = portfolio.positions.find((p) => p.fundId === fundId);
  if (!pos || pos.marketValue == null) return null;
  return (pos.marketValue / portfolio.totalWealth) * 100;
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
    relevance: 72,
    ctaLabel: `View ${earn.displayName} on SoDEX`,
    ctaHref: SODEX_WEALTH_URL,
  };
}

function yieldGapCard(catalog: WealthFundView[]): WealthSuggestion | null {
  const yieldFunds = catalog
    .filter((f) => f.category === "stable_earn" && f.apy7d != null)
    .sort((a, b) => (b.apy7d ?? 0) - (a.apy7d ?? 0));
  if (yieldFunds.length < 2) return null;
  const hi = yieldFunds[0];
  const lo = yieldFunds[yieldFunds.length - 1];
  const gap = (hi.apy7d ?? 0) - (lo.apy7d ?? 0);
  if (gap < YIELD_GAP_PP) return null;
  return {
    id: "eff-yield-gap",
    kind: "yield_rotation",
    fundId: hi.fundId,
    observation: `${hi.displayName}'s 7-day APY (${pct(hi.apy7d)}) is currently higher than ${lo.displayName}'s (${pct(lo.apy7d)}).`,
    option: `Both are Stable Earn products; the ${gap.toFixed(2)}-point gap is one factor among several (duration, backing, redemption terms).`,
    inputs: [
      `${hi.displayName} 7D APY: ${pct(hi.apy7d)} (as of ${when(hi.asOf)})`,
      `${lo.displayName} 7D APY: ${pct(lo.apy7d)} (as of ${when(lo.asOf)})`,
      `Difference: ${gap.toFixed(2)} points`,
    ],
    sources: [],
    riskNote: null,
    asOf: hi.asOf ?? new Date().toISOString(),
    relevance: 56,
    ctaLabel: "Compare on SoDEX",
    ctaHref: SODEX_WEALTH_URL,
  };
}

// ── Event/news-led ─────────────────────────────────────────────────────

function eventCard(
  fund: WealthFundView,
  news: WealthNewsItem[],
  helix: HelixMatch[],
  portfolio: WealthPortfolio | null,
  now: number,
): WealthSuggestion | null {
  const recentNews = news.filter(
    (n) => n.ts && now - Date.parse(n.ts) <= 2 * DAY,
  );
  const bull = recentNews.filter((n) => n.sentiment === "Bullish").length;
  const bear = recentNews.filter((n) => n.sentiment === "Bearish").length;

  // Trigger: ≥2 recent news items, or any matched Helix event.
  if (recentNews.length < 2 && helix.length === 0) return null;

  const conc = concentrationPct(portfolio, fund.fundId);
  if (conc != null && conc > CONCENTRATION_SUPPRESS_PCT) return null; // guardrail

  const retLabel =
    fund.changePct != null
      ? `${fund.displayName} is ${pct(fund.changePct)} over 24h`
      : fund.headlineValue != null
        ? `${fund.displayName}'s ${fund.headlineLabel.toLowerCase()} is ${pct(fund.headlineValue)}`
        : fund.displayName;
  const monthCtx =
    fund.roi1M != null ? `, ${pct(fund.roi1M)} over the past month` : "";

  const inputs: string[] = [];
  if (recentNews.length) {
    inputs.push(`SoDEX news items (48h): ${recentNews.length}` + (bull || bear ? ` — ${bull} bullish, ${bear} bearish` : ""));
  }
  if (helix.length) inputs.push(`Matching Helix events (48h): ${helix.length}`);
  if (fund.changePct != null) inputs.push(`24h change: ${pct(fund.changePct)} (as of ${when(fund.asOf)})`);
  if (fund.roi1M != null) inputs.push(`1-month return: ${pct(fund.roi1M)}`);
  if (fund.headlineValue != null && fund.isYield) inputs.push(`${fund.headlineLabel}: ${pct(fund.headlineValue)}`);

  const sources = [
    ...helix.map((h) => ({ label: `Helix: ${h.title.slice(0, 80)}`, href: h.href ?? undefined, ts: h.ts })),
    ...recentNews.slice(0, 3).map((n) => ({
      label: `${n.sentiment ? n.sentiment + " · " : ""}${n.title.slice(0, 80)}`,
      href: n.url ?? undefined,
      ts: n.ts ?? undefined,
    })),
  ].slice(0, 4);

  const newestTs = [
    ...recentNews.map((n) => (n.ts ? Date.parse(n.ts) : 0)),
    ...helix.map((h) => Date.parse(h.ts)),
    fund.asOf ? Date.parse(fund.asOf) : 0,
  ].reduce((a, b) => Math.max(a, b), 0);

  let relevance =
    60 + recentNews.length * 3 + (bull + bear) * 2 + helix.length * 6 + Math.min(10, Math.abs(fund.changePct ?? 0));
  let riskNote: string | null = null;
  if (conc != null) {
    riskNote = `${fund.displayName} is already ${conc.toFixed(1)}% of your wealth book.`;
    if (conc > CONCENTRATION_FLAG_PCT) relevance -= 25; // downgrade
  }

  const sentimentPhrase =
    recentNews.length >= 2
      ? ` (${bull} flagged bullish, ${bear} bearish)`
      : "";

  return {
    id: `evt-${fund.fundId}`,
    kind: "event",
    fundId: fund.fundId,
    observation:
      recentNews.length >= 2
        ? `${fund.displayName} (${fund.symbol}) has ${recentNews.length} news items in the last 48h${sentimentPhrase}.`
        : `There ${helix.length === 1 ? "is" : "are"} ${helix.length} recent Helix event${helix.length === 1 ? "" : "s"} touching ${fund.displayName} (${fund.symbol}).`,
    option: `${retLabel}${monthCtx}.`,
    inputs,
    sources,
    riskNote,
    asOf: newestTs > 0 ? new Date(newestTs).toISOString() : new Date().toISOString(),
    relevance,
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

  // Pull recent Helix events once (crypto-weighted stream; matches for these
  // US-equity / China / yield funds will be sparse, and that's fine).
  let helixEvents: Awaited<ReturnType<typeof Events.listRecentEvents>> = [];
  try {
    helixEvents = await Events.listRecentEvents({ limit: 150 });
  } catch {
    helixEvents = [];
  }

  // SoDEX per-fund news for funds we have a verified seoName for.
  const newsFunds = catalog.filter((f) => f.newsSeo);
  const newsResults = await Promise.all(
    newsFunds.map((f) => fetchFundNews(f.newsSeo as string, 30).then((n) => [f.fundId, n] as const)),
  );
  const newsByFund = new Map(newsResults);

  const cards: WealthSuggestion[] = [];

  // Efficiency baseline (always evaluated)
  const idle = idleUsdcCard(catalog, idleUsdc, idleUsdcAsOf);
  if (idle) cards.push(idle);
  const gap = yieldGapCard(catalog);
  if (gap) cards.push(gap);

  // Event/news-led (primary)
  for (const fund of catalog) {
    const news = newsByFund.get(fund.fundId) ?? [];
    const helix = matchHelixEvents(helixEvents, FUND_KEYWORDS[fund.fundId] ?? [], now);
    const card = eventCard(fund, news, helix, portfolio, now);
    if (card) cards.push(card);
  }

  // Rank by relevance; cap at 5. Events can lead, but the efficiency baseline
  // always keeps a slot when one exists (swap it in for the weakest card).
  cards.sort((a, b) => b.relevance - a.relevance);
  const top = cards.slice(0, 5);
  const isEff = (k: string) => k === "efficiency" || k === "yield_rotation";
  if (top.length > 0 && !top.some((c) => isEff(c.kind))) {
    const bestEff = cards.find((c) => isEff(c.kind));
    if (bestEff) top[top.length - 1] = bestEff;
  }
  return top;
}
