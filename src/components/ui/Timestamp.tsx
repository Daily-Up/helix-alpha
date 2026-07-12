"use client";

import { useEffect, useState } from "react";
import { cn } from "./cn";

function absFmt(ms: number): string {
  const d = new Date(ms);
  const day = d.getUTCDate();
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${mon}, ${hh}:${mm} UTC`;
}
function relFmt(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 0) return "now";
  if (s < 60) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * The ONE timestamp format, app-wide. Absolute + relative. Renders the
 * absolute string on first paint (SSR-safe, no hydration mismatch) and
 * swaps to a live relative after mount for `mode="relative"`.
 */
export function Timestamp({
  ms,
  mode = "relative",
  className,
}: {
  ms: number;
  mode?: "relative" | "absolute";
  className?: string;
}) {
  const [rel, setRel] = useState<string | null>(null);
  useEffect(() => {
    setRel(relFmt(ms));
    const t = setInterval(() => setRel(relFmt(ms)), 60_000);
    return () => clearInterval(t);
  }, [ms]);

  const abs = absFmt(ms);
  if (mode === "absolute") {
    return (
      <span title={rel ?? undefined} className={cn("tabular-nums text-fg-muted", className)}>
        {abs}
      </span>
    );
  }
  return (
    <span title={abs} className={cn("tabular-nums text-fg-muted", className)}>
      {rel ?? abs}
    </span>
  );
}
