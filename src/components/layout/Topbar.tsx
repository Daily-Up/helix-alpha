"use client";

import { useEffect, useState } from "react";

/**
 * Top bar — shows the current UTC time + a "live" indicator.
 *
 * The clock starts as an empty string on first SSR/CSR render — populating
 * it on mount avoids a server/client hydration mismatch (the server's
 * timestamp is always seconds older than the browser's by the time hydration
 * runs, which trips Next.js's hydration checker).
 */
export function Topbar() {
  const [now, setNow] = useState<string>("");

  useEffect(() => {
    const tick = () => setNow(new Date().toISOString().slice(11, 19));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-line bg-bg/90 px-6 backdrop-blur">
      <div className="flex items-center gap-2 text-xs text-fg-muted">
        {/* suppressHydrationWarning is belt-and-suspenders: the empty initial
            value means there's nothing to mismatch, but if a future change
            ever inlines `new Date()` again this stops the noisy console. */}
        <span className="tabular text-fg" suppressHydrationWarning>
          {now || "——:——:——"}
        </span>
        <span className="text-fg-dim">UTC</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5">
          <span className="dash-live-dot" aria-hidden />
          <span className="font-[var(--font-jetbrains-mono)] text-[11px] uppercase text-fg-muted" style={{ letterSpacing: "0.1em" }}>
            Live
          </span>
        </span>
      </div>
    </header>
  );
}
