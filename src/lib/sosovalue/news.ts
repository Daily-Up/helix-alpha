/**
 * SoSoValue News Feed endpoints (6.x).
 *
 * Note: the API exposes only the most recent 7 days via start_time/end_time.
 * For deeper history we accumulate locally — see src/lib/db/events.ts.
 */

import { sosoGet } from "./client";
import { toMs } from "./types";
import type {
  NewsCategoryValue,
  NewsItem,
  NewsLanguage,
  NewsQuery,
  NewsResponse,
} from "./types";

/**
 * GET /news — paginated news feed.
 *
 * @param query Filters; pagination defaults to page=1, page_size=20.
 *              page_size capped at 100 by the API.
 */
export function getNews(query: NewsQuery = {}): Promise<NewsResponse> {
  return sosoGet<NewsResponse>("/news", { query });
}

/**
 * GET /news/hot — currently hot/trending news.
 * No documented query schema; returns the same NewsItem shape.
 */
export function getHotNews(opts?: {
  language?: NewsLanguage;
  limit?: number;
}): Promise<NewsItem[]> {
  return sosoGet<NewsItem[]>("/news/hot", { query: opts });
}

/**
 * GET /news/featured — editorially featured items.
 */
export function getFeaturedNews(opts?: {
  language?: NewsLanguage;
  limit?: number;
}): Promise<NewsItem[]> {
  return sosoGet<NewsItem[]>("/news/featured", { query: opts });
}

/**
 * GET /news/search — keyword search across news.
 *
 * ⚠️ Despite earlier assumptions, /news/search IS subject to the same
 * 7-day window cap on the free API tier (verified 2026-05). Both /news
 * and /news/search are gated server-side ("constraint: time range
 * limited to last 7 days for your API key plan"). Historical access
 * requires a paid SoSoValue plan upgrade.
 */
export function searchNews(query: {
  keyword: string;
  page?: number;
  /** Default 20, max 50. */
  page_size?: number;
  category?: NewsCategoryValue;
  /** "relevance" (default) or "publish_time". */
  sort?: "relevance" | "publish_time";
}): Promise<NewsResponse> {
  return sosoGet<NewsResponse>("/news/search", { query });
}

/**
 * Pull the full last-N-days news feed by paging through `/news`.
 *
 * The API caps `start_time`/`end_time` to the last 7 days, so this helper
 * automatically clamps to that window. Returns items oldest-first so they
 * can be streamed into the event store.
 */
export async function fetchRecentNews(opts: {
  daysBack: number; // 1..7
  category?: NewsCategoryValue;
  currencyId?: string;
  language?: NewsLanguage;
  /** Max items to ever return; default 1000. */
  maxItems?: number;
}): Promise<NewsItem[]> {
  const days = Math.min(7, Math.max(1, Math.floor(opts.daysBack)));
  const end = Date.now();
  const start = end - days * 24 * 60 * 60 * 1000;
  const max = opts.maxItems ?? 1000;

  const collected: NewsItem[] = [];
  const pageSize = 100;
  let page = 1;

  while (collected.length < max) {
    const resp = await getNews({
      category: opts.category,
      currency_id: opts.currencyId,
      language: opts.language ?? "en",
      page,
      page_size: pageSize,
      start_time: start,
      end_time: end,
    });

    if (!resp.list || resp.list.length === 0) break;
    collected.push(...resp.list);

    if (page * pageSize >= Number(resp.total)) break;
    if (resp.list.length < pageSize) break;
    page += 1;
  }

  return collected
    .slice(0, max)
    .sort((a, b) => toMs(a.release_time) - toMs(b.release_time));
}
