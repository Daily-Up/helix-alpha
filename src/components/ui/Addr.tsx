"use client";

import { useState } from "react";
import { cn } from "./cn";
import { Empty } from "./Empty";

/**
 * The ONE address format, app-wide: 0x1234…5678, click-to-copy the full
 * value. Zero local `slice()` variants anywhere else.
 */
export function Addr({
  value,
  tail = 4,
  className,
}: {
  value: string | null | undefined;
  tail?: number;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!value) return <Empty className={className} />;
  const short = `${value.slice(0, 6)}…${value.slice(-tail)}`;
  return (
    <button
      type="button"
      title={copied ? "copied!" : `${value} — click to copy`}
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className={cn(
        "cursor-pointer font-[var(--font-jetbrains-mono)] text-fg-muted transition-colors hover:text-fg",
        className,
      )}
    >
      {copied ? "copied ✓" : short}
    </button>
  );
}
