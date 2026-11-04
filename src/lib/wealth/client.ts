/**
 * Server-side fetchers for the SoDEX Wealth API + per-fund news.
 *
 * These run inside Helix API routes (never the browser) so there's no CORS
 * issue and we can cache. SoDEX responses are the usual {code,msg,data}
 * envelope. We parse defensively and never fabricate values — a missing or
 * malformed field becomes null/[] rather than a guess.
 */

import { buildCatalog } from "./catalog";
import type {
  WealthFundRaw,
  WealthFundView,
  WealthHistoryPoint,
  WealthPortfolio,
  WealthPositionRaw,
  WealthQuoteRaw,
} from "./types";

const WEALTH_API = "https://wealth.sodex.dev/api/v1/wealth";
const NEWS_API = "https://alpha-biz.sodex.dev/biz/v1";
const SPOT_API = "https://mainnet-gw.sodex.dev/api/v1/spot";

async function getJson<T>(url: string, timeoutMs = 10_000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const json = (await res.json()) as { code?: number; msg?: string; data?: T };
    if (json.code !== undefined && json.code !== 0) {
      throw new Error(json.msg || `code ${json.code}`);
    }
    return json.data as T;
  } finally {
    clearTimeout(t);
  }
}

function num(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function fetchFunds(): Promise<WealthFundRaw[]> {
  return (await getJson<WealthFundRaw[]>(`${WEALTH_API}/funds`)) ?? [];
}

export async function fetchMarkets(): Promise<WealthQuoteRaw[]> {
  const data = await getJson<{ quotes?: WealthQuoteRaw[] }>(`${WEALTH_API}/markets`);
  return data?.quotes ?? [];
}

/** The merged catalog: live funds + their market quotes, as view rows. */
export async function fetchCatalog(): Promise<WealthFundView[]> {
  const [funds, quotes] = await Promise.all([fetchFunds(), fetchMarkets()]);
  return buildCatalog(funds, quotes);
}

export async function fetchPriceHistory(
  fundId: string,
  interval = "1d",
  range = "1Y",
): Promise<WealthHistoryPoint[]> {
  const data = await getJson<{ points?: Array<{ ts: string; close: string | number }> }>(
    `${WEALTH_API}/funds/${encodeURIComponent(fundId)}/price-history?interval=${interval}&range=${range}`,
  );
  return (data?.points ?? [])
    .map((p) => ({ ts: p.ts, close: Number(p.close) }))
    .filter((p) => Number.isFinite(p.close));
}

export async function fetchPortfolio(address: string): Promise<WealthPortfolio> {
  const d = await getJson<{
    settledValue?: string;
    totalCost?: string;
    totalPnl?: string;
    totalRealizedPnl?: string;
    totalUnrealizedPnl?: string;
    totalPnl24h?: string;
    totalValue?: string;
    totalWealth?: string;
    positions?: WealthPositionRaw[];
  }>(`${WEALTH_API}/users/${address}/pnl`);

  return {
    address,
    totalWealth: num(d?.totalWealth),
    totalValue: num(d?.totalValue),
    settledValue: num(d?.settledValue),
    totalCost: num(d?.totalCost),
    totalPnl: num(d?.totalPnl),
    totalPnl24h: num(d?.totalPnl24h),
    totalRealizedPnl: num(d?.totalRealizedPnl),
    totalUnrealizedPnl: num(d?.totalUnrealizedPnl),
    positions: (d?.positions ?? []).map((p) => ({
      fundId: p.fundId,
      shares: num(p.shares),
      price: num(p.price),
      marketValue: num(p.marketValue),
      unrealizedPnl: num(p.unrealizedPnl),
      realizedPnl: num(p.realizedPnl),
      pnl24h: num(p.pnl24h),
    })),
  };
}

/**
 * Available USDC in the wallet's SoDEX spot balance — the "idle cash" input
 * for the efficiency suggestion. Returns { usdc, asOf } with usdc=null when
 * the balance can't be read (→ no idle-USDC card). available = total − locked.
 */
export async function fetchSpotUsdc(
  address: string,
): Promise<{ usdc: number | null; asOf: string }> {
  const asOf = new Date().toISOString();
  try {
    const d = await getJson<{ B?: Array<{ a: string; t: string; l: string }> }>(
      `${SPOT_API}/accounts/${address}/state`,
    );
    const row = (d?.B ?? []).find((b) => /usdc/i.test(b.a));
    if (!row) return { usdc: null, asOf };
    const total = num(row.t) ?? 0;
    const locked = num(row.l) ?? 0;
    const avail = Math.max(0, total - locked);
    return { usdc: avail, asOf };
  } catch {
    return { usdc: null, asOf };
  }
}

// ── Per-fund news (alpha-biz) — supplementary source for suggestions ────

export interface WealthNewsItem {
  id: string;
  title: string;
  summary: string | null;
  url: string | null;
  ts: string | null; // ISO
  sentiment: "Bullish" | "Bearish" | "Neutral" | null;
  source: string | null;
}

interface RawNews {
  id?: string | number;
  title?: string;
  transferTitle?: string;
  summary?: string;
  createTime?: number | string;
  realiseTime?: number | string;
  originalLink?: string;
  sourceLink?: string;
  source?: string;
  sourceDescription?: string;
  tone?: string;
  aiResult?: string;
}

function toIso(t: number | string | undefined): string | null {
  if (t == null) return null;
  const n = typeof t === "string" ? Number(t) : t;
  if (!Number.isFinite(n)) return null;
  // alpha-biz uses epoch ms.
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function sentimentOf(r: RawNews): WealthNewsItem["sentiment"] {
  const t = r.tone?.toLowerCase();
  if (t === "bullish" || t === "positive") return "Bullish";
  if (t === "bearish" || t === "negative") return "Bearish";
  if (t === "neutral") return "Neutral";
  if (r.aiResult) {
    try {
      const s = String(JSON.parse(r.aiResult)?.sentiment ?? "").toLowerCase();
      if (s.includes("bull") || s.includes("positive")) return "Bullish";
      if (s.includes("bear") || s.includes("negative")) return "Bearish";
      if (s.includes("neutral")) return "Neutral";
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Recent news for a fund's underlying. Returns [] on any failure. */
export async function fetchFundNews(
  seoName: string,
  pageSize = 20,
): Promise<WealthNewsItem[]> {
  try {
    // The intelligence endpoint wraps items in data.list (paginated), not
    // data directly.
    const data = await getJson<{ list?: RawNews[] }>(
      `${NEWS_API}/asset/intelligence?seoName=${encodeURIComponent(
        seoName,
      )}&infoType=news&lang=en&pageSize=${pageSize}`,
    );
    const arr = data?.list ?? [];
    return arr.map((r, i) => ({
      id: String(r.id ?? i),
      title: r.transferTitle || r.title || "",
      summary: r.summary ?? null,
      url: r.originalLink || r.sourceLink || null,
      ts: toIso(r.createTime ?? r.realiseTime),
      sentiment: sentimentOf(r),
      source: r.source || r.sourceDescription || null,
    }));
  } catch {
    return [];
  }
}
