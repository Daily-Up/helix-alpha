"use client";

/**
 * Run-live-agent button — now with live-typing trace.
 *
 * Hits POST /api/agent/demo which returns a trace_id immediately and
 * runs the agent in a Next.js `after()` block. We render a
 * LiveAgentTrace below the button that polls /api/data/trace?id=...
 * every 800ms, so each step (thinking, tool call, result, final
 * classification) shows up the moment it's persisted — no more
 * "click and wait 30s of silence".
 */

import { useState } from "react";
import { cn } from "@/components/ui/cn";
import { LiveAgentTrace } from "./LiveAgentTrace";

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

const DURATION_HINT: Record<Props["mode"], string> = {
  research: "~10s",
  verification: "~10s",
  debate: "~30s",
};

export function RunLiveAgentButton({
  event_id,
  signal_id,
  mode,
  className,
}: Props) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [traceId, setTraceId] = useState<string | null>(null);

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
    setTraceId(null);
    try {
      const res = await fetch(
        `/api/agent/demo?mode=${mode}&${target}`,
        { method: "POST" },
      );
      const body = (await res.json()) as {
        ok: boolean;
        error?: string;
        trace_id?: string;
      };
      if (!res.ok || !body.ok) {
        setError(body.error ?? `request failed (${res.status})`);
        setRunning(false);
        return;
      }
      // Debate mode doesn't return a single trace_id (it spawns three);
      // for that path we fall back to a page reload after a short
      // delay so the new traces appear in the main list.
      if (body.trace_id) {
        setTraceId(body.trace_id);
      } else {
        setTimeout(() => window.location.reload(), 35_000);
      }
    } catch (err) {
      setError((err as Error).message ?? "request failed");
      setRunning(false);
    }
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <button
        type="button"
        onClick={go}
        disabled={running}
        className={cn(
          "inline-flex w-fit items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors",
          running
            ? "cursor-wait border-line bg-surface-2 text-fg-dim"
            : "border-accent/40 bg-accent/15 text-accent-2 hover:bg-accent/25",
        )}
      >
        {running ? (
          <>
            <Spinner /> Running…
          </>
        ) : (
          <>
            ▶ {LABEL[mode]}{" "}
            <span className="text-[10px] font-normal text-fg-dim">
              ({DURATION_HINT[mode]})
            </span>
          </>
        )}
      </button>
      {error ? (
        <span className="text-[11px] text-negative">{error}</span>
      ) : null}
      {traceId ? (
        <LiveAgentTrace
          traceId={traceId}
          onComplete={() => setRunning(false)}
        />
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
