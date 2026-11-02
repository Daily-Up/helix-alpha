"use client";

import { useEffect, useState } from "react";
import { TradeModeBadge } from "./TradeModeBadge";
import { MobileNav } from "./MobileNav";

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
      <div className="flex items-center gap-3">
        <MobileNav />
      </div>
      {/* Clock sits with the trade-mode badge on the right so it doesn't float
          alone on the left. suppressHydrationWarning: the empty initial value
          means nothing to mismatch. */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5 text-xs text-fg-muted">
          <span className="tabular text-fg" suppressHydrationWarning>
            {now || "——:——:——"}
          </span>
          <span className="text-fg-dim">UTC</span>
        </div>
        <TradeModeBadge />
      </div>
    </header>
  );
}
