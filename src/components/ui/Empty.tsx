import { cn } from "./cn";
import { EMPTY_GLYPH } from "@/lib/format/num";

/**
 * The ONE "nothing" glyph, app-wide. Renders at ~40% opacity so absence
 * recedes and real values pop. Never `$0.00` here and `—` there.
 */
export function Empty({ className }: { className?: string }) {
  return (
    <span
      aria-label="no value"
      className={cn("tabular-nums text-fg-dim opacity-40", className)}
    >
      {EMPTY_GLYPH}
    </span>
  );
}
