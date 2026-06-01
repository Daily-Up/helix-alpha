"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EventCard, type EventCardData } from "./EventCard";
import { EventFilters, type FilterState } from "./EventFilters";

/**
 * Live-updating event feed.
 *
 * Fetches /api/data/events and re-fetches every 30s. When filters change,
 * fetches immediately. Also surfaces a "Pull latest" affordance whenever
 * the newest event in the feed is older than STALE_THRESHOLD_MS — that
 * lets visitors yank fresh data on demand even when the upstream GHA
 * cron is throttled.
 */

// If the newest event is older than this, show a stale banner with a
// manual "Pull latest" button. Anything under 20 min is "fresh enough"
// given the GHA tick fires roughly every 15-20 min on a good day.
const STALE_THRESHOLD_MS = 20 * 60 * 1000;

export function EventFeed() {
  const [events, setEvents] = useState<EventCardData[]>([]);
  const [filters, setFilters] = useState<FilterState>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullMsg, setPullMsg] = useState<string | null>(null);
  // Ticks every 30s so the "minutes ago" / stale flag re-evaluates even
  // when the events list itself hasn't changed.
  const [now, setNow] = useState(() => Date.now());

  const fetchEvents = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (filters.event_type) params.set("event_type", filters.event_type);
      if (filters.sentiment) params.set("sentiment", filters.sentiment);
      if (filters.severity) params.set("severity", filters.severity);

      const res = await fetch(`/api/data/events?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { events: EventCardData[] };
      setEvents(data.events);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchEvents();
    const t = setInterval(fetchEvents, 30_000);
    const clockT = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(t);
      clearInterval(clockT);
    };
  }, [fetchEvents]);

  const newest = events[0]?.release_time;
  const stale = useMemo(() => {
    if (!newest) return false;
    return now - newest > STALE_THRESHOLD_MS;
  }, [newest, now]);
  const newestAgeMin = newest ? Math.round((now - newest) / 60000) : null;

  const pullLatest = useCallback(async () => {
    if (pulling) return;
    setPulling(true);
    setPullMsg(null);
    try {
      const res = await fetch("/api/public/run-tick", { method: "POST" });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        retry_after_s?: number;
        summary?: {
          ingest?: { new_events?: number; classified?: number };
        };
      };
      if (data.ok) {
        const n = data.summary?.ingest?.new_events ?? 0;
        const c = data.summary?.ingest?.classified ?? 0;
        setPullMsg(
          n > 0
            ? `✓ pulled ${n} new event${n === 1 ? "" : "s"} (${c} classified)`
            : "✓ checked SoSoValue — nothing new yet",
        );
        await fetchEvents();
      } else if (data.retry_after_s != null) {
        setPullMsg(
          `Rate limited — someone else just refreshed. Try again in ${data.retry_after_s}s.`,
        );
      } else {
        setPullMsg(`✗ ${data.error ?? "pull failed"}`);
      }
    } catch (err) {
      setPullMsg(`✗ ${(err as Error).message}`);
    } finally {
      setPulling(false);
    }
  }, [pulling, fetchEvents]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <EventFilters value={filters} onChange={setFilters} />
        <div className="flex items-center gap-3">
          {newestAgeMin != null ? (
            <span
              className="text-xs"
              style={{ color: stale ? "#d1a85a" : "#5d584e" }}
              title="Time since the newest event in the feed"
            >
              newest {newestAgeMin}m ago
            </span>
          ) : null}
          <button
            onClick={pullLatest}
            disabled={pulling}
            className="rounded border px-2.5 py-1 text-xs font-medium transition-colors"
            style={{
              borderColor: stale
                ? "rgba(217, 119, 87, 0.4)"
                : "rgba(237, 228, 211, 0.12)",
              background: stale ? "rgba(217, 119, 87, 0.10)" : "transparent",
              color: stale ? "#d97757" : "#8a857a",
              cursor: pulling ? "wait" : "pointer",
            }}
            title="Hits the pipeline once: ingest news → classify → generate signals → reconcile."
          >
            {pulling ? "Pulling…" : "↻ Pull latest"}
          </button>
          <span className="text-xs text-fg-dim">
            {loading ? "loading..." : `${events.length} events`}
          </span>
        </div>
      </div>

      {/* Stale banner — only shown when the feed has any data AND it's old */}
      {stale && !pulling ? (
        <div
          className="rounded border px-3 py-2 text-xs"
          style={{
            borderColor: "rgba(217, 119, 87, 0.30)",
            background: "rgba(217, 119, 87, 0.06)",
            color: "#d97757",
          }}
        >
          Stream looks stale — newest event is {newestAgeMin}m ago. The
          scheduled pipeline runs every ~15 min but GitHub Actions throttles
          it under load. Click <strong>↻ Pull latest</strong> to force a
          fresh ingest now.
        </div>
      ) : null}

      {pullMsg ? (
        <div className="text-xs" style={{ color: "#8a857a" }}>
          {pullMsg}
        </div>
      ) : null}

      {error ? (
        <div className="rounded border border-negative/40 bg-negative/10 p-3 text-sm text-negative">
          Error loading events: {error}
        </div>
      ) : null}

      <div className="flex flex-col">
        {events.length === 0 && !loading ? (
          <div
            className="py-12 text-center font-[var(--font-inter)]"
            style={{
              fontSize: "13px",
              color: "#8a857a",
              borderTop: "1px solid rgba(237, 228, 211, 0.08)",
            }}
          >
            No events match these filters yet.
          </div>
        ) : (
          events.map((ev) => <EventCard key={ev.id} ev={ev} />)
        )}
      </div>
    </div>
  );
}
