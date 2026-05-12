"use client";

import { useCallback, useEffect, useState } from "react";
import { EventCard, type EventCardData } from "./EventCard";
import { EventFilters, type FilterState } from "./EventFilters";

/**
 * Live-updating event feed.
 *
 * Fetches /api/data/events and re-fetches every 30s. When filters change,
 * fetches immediately. Optimistic / cached UI later.
 */
export function EventFeed() {
  const [events, setEvents] = useState<EventCardData[]>([]);
  const [filters, setFilters] = useState<FilterState>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    return () => clearInterval(t);
  }, [fetchEvents]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <EventFilters value={filters} onChange={setFilters} />
        <span className="text-xs text-fg-dim">
          {loading ? "loading..." : `${events.length} events`}
        </span>
      </div>

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
