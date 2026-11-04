"use client";

/**
 * Event Stream data layer (client).
 *
 * Composes three live sources, all read-only and CORS-open from the browser:
 *   • /api/data/events          — classified news events (our DB)
 *   • SoDEX /markets/tickers     — perp last price + 24h change (movers, % move)
 *   • SoDEX /markets/klines      — 1D OHLC (hero/detail chart backgrounds, % move)
 *
 * Enriches each event with its SoDEX-tradable assets (via market-map), a
 * one-line takeaway, a dominant category, and clusters same-asset duplicates
 * within a 6h window into one card ("+N related").
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Market } from "@/lib/sodex";
import type { SodexCandle, SodexTicker } from "@/lib/sodex/types";
import { useTradeMode } from "@/lib/sodex-onchain/useTradeMode";
import { getPerpsAccountState } from "@/lib/sodex-onchain/client";
import {
  resolveAsset,
  baseCategory,
  type AssetRef,
  type MarketCategory,
} from "./market-map";

/** One classified event as returned by /api/data/events. */
export interface EventCardData {
  id: string;
  release_time: number;
  title: string;
  author: string | null;
  source_link: string | null;
  matched_currencies: Array<{ symbol: string }>;
  event_type: string | null;
  sentiment: "positive" | "negative" | "neutral" | null;
  severity: "high" | "medium" | "low" | null;
  confidence: number | null;
  affected_asset_ids: string[];
  reasoning: string | null;
  skip_reasoning?: string | null;
  skip_score?: number | null;
}

export interface StreamAsset extends AssetRef {
  /** % move since the event's release time, if klines cover it. */
  pctSinceEvent: number | null;
}

export interface StreamEvent extends EventCardData {
  assets: StreamAsset[];
  /** Assets that map to a live SoDEX perp (have a trade button). */
  tradable: StreamAsset[];
  /** One-line AI takeaway (first sentence of reasoning). */
  takeaway: string;
  category: MarketCategory;
  /** Related duplicate events merged under this card. */
  related: EventCardData[];
}

export interface Mover {
  symbol: string; // "AMD-USD"
  ticker: string; // "AMD"
  category: MarketCategory;
  last: number;
  changePct: number;
}

// ── perp markets (tickers) ────────────────────────────────────────────────────

interface PerpMarkets {
  perpSet: Set<string>;
  tickers: Map<string, { last: number; changePct: number }>;
  movers: Mover[];
}

const n = (v: unknown) => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

export function usePerpMarkets(): PerpMarkets {
  const [data, setData] = useState<PerpMarkets>({
    perpSet: new Set(),
    tickers: new Map(),
    movers: [],
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const rows = await Market.getTickers("perp");
        if (cancelled) return;
        const perpSet = new Set<string>();
        const tickers = new Map<string, { last: number; changePct: number }>();
        const all: Mover[] = [];
        for (const t of rows as SodexTicker[]) {
          const sym = t.symbol.toUpperCase();
          perpSet.add(sym);
          const last = n(t.lastPx);
          const changePct = n(t.changePct);
          tickers.set(sym, { last, changePct });
          const base = sym.replace(/-USDC?$/i, "");
          all.push({
            symbol: sym,
            ticker: base,
            category: baseCategory(base),
            last,
            changePct,
          });
        }
        const movers = all
          .filter((m) => m.last > 0)
          .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
        setData({ perpSet, tickers, movers });
      } catch {
        /* keep last good */
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return data;
}

// ── open positions (For You priority) ─────────────────────────────────────────

/** Base tickers (e.g. "BTC") the user holds an OPEN perp position in, read
 *  straight from SoDEX account state. Empty when no trading identity is set up.
 *  Read-only, polled slowly — drives the "For You" tab's top priority. */
export function useOpenPositionBases(): Set<string> {
  const tm = useTradeMode("mainnet");
  const [bases, setBases] = useState<Set<string>>(new Set());
  const address = tm.address;

  useEffect(() => {
    if (!address) {
      setBases(new Set());
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const st = await getPerpsAccountState("mainnet", address);
        if (cancelled) return;
        const s = new Set<string>();
        for (const p of st.P ?? []) {
          if (Number(p.sz) === 0) continue; // flat = not a holding
          const base = (p.s ?? "").toUpperCase().replace(/-USDC?$/, "");
          if (base) s.add(base);
        }
        setBases((prev) =>
          prev.size === s.size && [...s].every((b) => prev.has(b)) ? prev : s,
        );
      } catch {
        /* keep last good */
      }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [address]);

  return bases;
}

// ── events ────────────────────────────────────────────────────────────────────

function firstSentence(s: string | null | undefined, cap = 140): string {
  if (!s) return "";
  const trimmed = s.trim();
  const m = trimmed.match(/^[\s\S]*?[.!?](\s|$)/);
  const one = (m ? m[0] : trimmed).trim();
  return one.length > cap ? one.slice(0, cap - 1).trimEnd() + "…" : one;
}

function enrich(ev: EventCardData, perpSet: Set<string>): StreamEvent {
  const ids =
    ev.affected_asset_ids.length > 0
      ? ev.affected_asset_ids
      : ev.matched_currencies.map((c) => `tok-${c.symbol.toLowerCase()}`);
  const assets: StreamAsset[] = ids.map((id) => ({
    ...resolveAsset(id, perpSet),
    pctSinceEvent: null,
  }));
  const tradable = assets.filter((a) => a.sodexSymbol);
  const category: MarketCategory =
    tradable[0]?.category ?? assets[0]?.category ?? "crypto";
  return {
    ...ev,
    assets,
    tradable,
    takeaway: firstSentence(ev.reasoning) || ev.title,
    category,
    related: [],
  };
}

/** Cluster same-primary-asset events inside a 6h window into one card. */
function cluster(events: StreamEvent[]): StreamEvent[] {
  const SIX_H = 6 * 60 * 60 * 1000;
  const out: StreamEvent[] = [];
  const used = new Set<string>();
  for (const e of events) {
    if (used.has(e.id)) continue;
    const key = e.tradable[0]?.sodexSymbol ?? e.assets[0]?.id ?? null;
    if (!key) {
      out.push(e);
      used.add(e.id);
      continue;
    }
    const related: EventCardData[] = [];
    for (const other of events) {
      if (used.has(other.id) || other.id === e.id) continue;
      const okey = other.tradable[0]?.sodexSymbol ?? other.assets[0]?.id ?? null;
      if (okey === key && Math.abs(other.release_time - e.release_time) <= SIX_H) {
        related.push(other);
        used.add(other.id);
      }
    }
    used.add(e.id);
    out.push({ ...e, related });
  }
  return out;
}

export function useStreamEvents(perpSet: Set<string>): {
  events: StreamEvent[];
  loading: boolean;
  newestTs: number | null;
} {
  const [raw, setRaw] = useState<EventCardData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/data/events?limit=100");
        if (!res.ok) return;
        const j = (await res.json()) as { events: EventCardData[] };
        if (!cancelled) setRaw(j.events ?? []);
      } catch {
        /* keep last good */
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const events = useMemo(() => {
    const enriched = raw.map((e) => enrich(e, perpSet));
    return cluster(enriched);
  }, [raw, perpSet]);

  const newestTs = raw[0]?.release_time ?? null;
  return { events, loading, newestTs };
}

// ── klines cache (hero/detail charts + % move since event) ────────────────────

const klineCache = new Map<string, { at: number; candles: SodexCandle[] }>();
const KLINE_TTL = 5 * 60 * 1000;

/** Fetch 1D (15m × ~96) klines for a set of perp symbols, cached + deduped. */
export function useKlines(symbols: string[]): Map<string, SodexCandle[]> {
  const [map, setMap] = useState<Map<string, SodexCandle[]>>(new Map());
  const key = [...new Set(symbols.filter(Boolean))].sort().join(",");
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const want = key.split(",").filter(Boolean).slice(0, 30);
    if (want.length === 0) return;

    // Seed synchronously from the cache.
    setMap((prev) => {
      const m = new Map(prev);
      let changed = false;
      for (const s of want) {
        const c = klineCache.get(s);
        if (c && Date.now() - c.at < KLINE_TTL && !m.has(s)) {
          m.set(s, c.candles);
          changed = true;
        }
      }
      return changed ? m : prev;
    });

    const toFetch = want.filter((s) => {
      const c = klineCache.get(s);
      const fresh = c && Date.now() - c.at < KLINE_TTL;
      return !fresh && !inFlight.current.has(s);
    });
    if (toFetch.length === 0) return;
    toFetch.forEach((s) => inFlight.current.add(s));

    (async () => {
      await Promise.all(
        toFetch.map(async (symbol) => {
          try {
            const candles = await Market.getCandles(
              { symbol, interval: "15m", limit: 96 },
              "perp",
            );
            klineCache.set(symbol, { at: Date.now(), candles });
          } catch {
            klineCache.set(symbol, { at: Date.now(), candles: [] });
          } finally {
            inFlight.current.delete(symbol);
          }
        }),
      );
      if (cancelled) return;
      setMap((prev) => {
        const m = new Map(prev);
        for (const s of toFetch) m.set(s, klineCache.get(s)?.candles ?? []);
        return m;
      });
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return map;
}

/** % move from the candle nearest the event time to the latest close. */
export function pctSince(
  candles: SodexCandle[] | undefined,
  eventMs: number,
): number | null {
  if (!candles || candles.length < 2) return null;
  const last = Number(candles[candles.length - 1].close);
  if (!Number.isFinite(last) || last === 0) return null;
  // Candles are ascending; find the last one at/just before the event.
  let base: number | null = null;
  for (const c of candles) {
    if (c.openTime <= eventMs) base = Number(c.close);
    else break;
  }
  if (base == null) base = Number(candles[0].close); // event predates window
  if (!Number.isFinite(base) || base === 0) return null;
  return ((last - base) / base) * 100;
}
