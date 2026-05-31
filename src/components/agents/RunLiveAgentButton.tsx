"use client";

/**
 * Run-live-agent button.
 *
 * Hits the public /api/agent/demo endpoint, surfaces a loading state,
 * and reloads the page on success so the new trace cards appear.
 *
 * Disabled when the API returns 429 (rate limit) or 429-with-spend-cap;
 * the user sees the specific reason inline.
 */

import { useState } from "react";
import { cn } from "@/components/ui/cn";

interface Props {
  /** Required for mode='research'. */
  event_id?: string | null;
  /** Required for mode='verification' | 'debate'. */
  signal_id?: string | null;
  mode: "research" | "verification" | "debate";
  className?: string;
}

const LABEL: Record<Props["mode"], string> = {
  research: "Run live research agent",
  verification: "Run live verification agent",
  debate: "Run live 3-agent debate",
};

const COST_HINT: Record<Props["mode"], string> = {
  research: "~$0.04 · ~10s",
  verification: "~$0.04 · ~10s",
  debate: "~$0.12 · ~30s",
};

export function RunLiveAgentButton({
  event_id,
  signal_id,
  mode,
  className,
}: Props) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target =
    mode === "research"
      ? event_id
        ? `event_id=${encodeURIComponent(event_id)}`
        : null
      : signal_id
        ? `signal_id=${encodeURIComponent(signal_id)}`
        : null;

  if (!target) return null;

  async function go() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/agent/demo?mode=${mode}&${target}`,
        { method: "POST" },
      );
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? `request failed (${res.status})`);
        setRunning(false);
        return;
      }
      // Reload so the new trace card(s) appear.
      window.location.reload();
    } catch (err) {
      setError((err as Error).message ?? "request failed");
      setRunning(false);
    }
  }

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <button
        type="button"
        onClick={go}
        disabled={running}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors",
          running
            ? "cursor-wait border-line bg-surface-2 text-fg-dim"
            : "border-accent/40 bg-accent/15 text-accent-2 hover:bg-accent/25",
        )}
      >
        {running ? (
          <>
            <Spinner /> Running… (up to ~30s — page will reload)
          </>
        ) : (
          <>
            ▶ {LABEL[mode]}{" "}
            <span className="text-[10px] font-normal text-fg-dim">
              ({COST_HINT[mode]})
            </span>
          </>
        )}
      </button>
      {error ? (
        <span className="text-[11px] text-negative">{error}</span>
      ) : null}
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-fg-dim border-t-transparent"
      aria-hidden
    />
  );
}
