import { cn } from "./cn";

/**
 * Shared "Not financial advice" disclaimer — used wherever Helix surfaces a
 * concrete trade idea or suggestion (Wealth suggestions, Daily Briefing top
 * pick, Live Signals, Event Stream detail). One component so the wording and
 * styling stay consistent everywhere.
 */
export function NotFinancialAdvice({ className }: { className?: string }) {
  return (
    <span className={cn("text-[9.5px] text-fg-dim", className)}>
      Not financial advice
    </span>
  );
}
