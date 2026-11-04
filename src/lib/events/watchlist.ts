"use client";

/**
 * Watchlist — SoDEX perp symbols the user has starred, persisted in
 * localStorage and shared across the Event Stream (and anywhere else that
 * wants it). A custom "helix:watchlist" event keeps every mounted component in
 * sync within the tab; the native "storage" event covers other tabs.
 */

import { useCallback, useEffect, useState } from "react";

const KEY = "helix.watchlist";
const EVT = "helix:watchlist";

function read(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function write(list: string[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
    window.dispatchEvent(new Event(EVT));
  } catch {
    /* ignore (private mode / blocked) */
  }
}

export function useWatchlist(): {
  list: string[];
  has: (symbol: string) => boolean;
  toggle: (symbol: string) => void;
} {
  const [list, setList] = useState<string[]>([]);

  useEffect(() => {
    const sync = () => setList(read());
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener(EVT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(EVT, sync);
    };
  }, []);

  const toggle = useCallback((symbol: string) => {
    const cur = read();
    const next = cur.includes(symbol)
      ? cur.filter((s) => s !== symbol)
      : [...cur, symbol];
    write(next);
    setList(next);
  }, []);

  const has = useCallback((symbol: string) => list.includes(symbol), [list]);

  return { list, has, toggle };
}

/** /trade deep link with a market pre-selected and a side preset. */
export function tradeHref(sodexSymbol: string, side?: "long" | "short"): string {
  const q = new URLSearchParams({ market: sodexSymbol });
  if (side) q.set("side", side);
  return `/trade?${q.toString()}`;
}
