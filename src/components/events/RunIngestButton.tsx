"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";

/**
 * Auto-ingest control.
 *
 * When `auto` is on (default), the component polls `/api/cron/ingest-news`
 * every 5 minutes — no more clicking a button to see the latest news.
 * The toggle persists to localStorage so it survives reloads.
 *
 * Manual "Run now" still available next to the toggle for the demo case
 * where you want a result in seconds.
 */
const AUTO_INTERVAL_MS = 5 * 60 * 1000;
const STORAGE_KEY = "helix.autoIngest.v1";

interface IngestResult {
  ok: true;
  fetched: number;
  new_events: number;
  classified: number;
  latency_ms: number;
}

interface IngestError {
  ok: false;
  error: string;
}

export function RunIngestButton({
  onComplete,
}: {
  onComplete?: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [auto, setAuto] = useState<boolean>(true);
  const [result, setResult] = useState<IngestResult | IngestError | null>(null);
  const [lastTick, setLastTick] = useState<number | null>(null);
  const runningRef = useRef(false);

  // Hydrate the toggle from localStorage on mount.
  useEffect(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === "0") setAuto(false);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, auto ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [auto]);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try {
      const res = await fetch("/api/cron/ingest-news");
      const data = (await res.json()) as IngestResult | IngestError;
      setResult(data);
      setLastTick(Date.now());
      if (data.ok) onComplete?.();
    } catch (err) {
      setResult({ ok: false, error: (err as Error).message });
    } finally {
      setRunning(false);
      runningRef.current = false;
    }
  }, [onComplete]);

  // Auto-ingest poller — only fires while `auto` is true.
  useEffect(() => {
    if (!auto) return;
    // Run once immediately so the user doesn't wait 5 min after enabling.
    run();
    const id = setInterval(run, AUTO_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  return (
    <div className="flex items-center gap-3">
      <label
        className="inline-flex cursor-pointer items-center gap-2 text-xs text-fg-muted"
        title={`Auto-ingest checks SoSoValue every ${AUTO_INTERVAL_MS / 60000}min and classifies the next batch. Toggle off to pause.`}
      >
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => setAuto(e.target.checked)}
          className="cursor-pointer"
        />
        Auto-ingest
        {auto ? (
          <span
            className="inline-flex h-1.5 w-1.5 rounded-full"
            style={{
              background: running ? "#d97757" : "#5cc97a",
              animation: running ? "pulse 1s ease-in-out infinite" : undefined,
            }}
            aria-hidden
          />
        ) : null}
      </label>

      <button
        onClick={run}
        disabled={running}
        className={cn(
          "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
          running
            ? "cursor-wait border-line bg-surface-2 text-fg-muted"
            : "border-accent/40 bg-accent/15 text-accent-2 hover:bg-accent/25",
        )}
      >
        {running ? "Running…" : "▶ Run now"}
      </button>

      {result ? (
        result.ok ? (
          <span className="tabular text-xs text-fg-muted">
            ✓ fetched {result.fetched} · new {result.new_events} ·
            classified {result.classified} · {(result.latency_ms / 1000).toFixed(1)}s
          </span>
        ) : (
          <span className="text-xs text-negative">✗ {result.error}</span>
        )
      ) : auto && lastTick == null ? (
        <span className="text-xs text-fg-dim">Polling on a 5-minute cadence…</span>
      ) : null}
    </div>
  );
}
