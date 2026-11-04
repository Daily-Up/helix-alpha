"use client";

/**
 * IngestStatus — compact freshness line for the right rail: last ingest time
 * with a green (fresh) / amber (stale) dot. No fetched/new/rejected debug line.
 */

import { fmtRelative } from "@/lib/format";
import { cn } from "@/components/ui/cn";

const FRESH_MS = 20 * 60 * 1000;

export function IngestStatus({ lastIngestMs }: { lastIngestMs: number | null }) {
  const age = lastIngestMs ? Date.now() - lastIngestMs : null;
  const fresh = age != null && age < FRESH_MS;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-[11px]">
      <span
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          fresh ? "bg-positive" : "bg-[#e0a53f]",
        )}
      />
      <span className="text-fg-dim">Last ingest</span>
      <span className="ml-auto font-[var(--font-jetbrains-mono)] tabular-nums text-fg-muted">
        {lastIngestMs ? fmtRelative(lastIngestMs) : "—"}
      </span>
    </div>
  );
}
