"use client";

import { buttonClass } from "@/components/ui/Button";

/**
 * Graceful fallback for a data section whose fetch failed — a calm, on-brand
 * "temporarily unavailable" card with a Retry, shown INSTEAD of letting the
 * render crash into the route error boundary (or blanking the page). Use it
 * wherever a client component fetches its own data and the response can fail
 * (e.g. the backing API 500s while the database is briefly unavailable).
 */
export function SectionError({
  onRetry,
  message,
  className,
}: {
  onRetry?: () => void;
  message?: string;
  className?: string;
}) {
  return (
    <div
      className={
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-line bg-surface p-8 text-center" +
        (className ? ` ${className}` : "")
      }
    >
      <span className="font-[var(--font-jetbrains-mono)] text-[10px] uppercase tracking-[0.2em] text-fg-dim">
        Data unavailable
      </span>
      <p className="max-w-sm text-sm leading-relaxed text-fg-muted">
        {message ??
          "Couldn't load this right now — the data service may be briefly unavailable. This is usually temporary."}
      </p>
      {onRetry ? (
        <button
          onClick={onRetry}
          className={buttonClass("primary", "px-4 py-1.5 text-[12px]")}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
