"use client";

/**
 * SuggestionCard — one factual "here's what you can do" card. Shows the
 * observation + option, the exact inputs it was built from (with timestamps),
 * linked sources (Helix events / SoDEX news), any attached risk context, the
 * data freshness, and a "Not financial advice" note. Nothing here is a
 * directive and no number appears that isn't in `inputs`.
 */

import { cn } from "@/components/ui/cn";
import { buttonClass } from "@/components/ui/Button";
import { NotFinancialAdvice } from "@/components/ui/NotFinancialAdvice";
import { fmtRelative } from "@/lib/format";
import type { WealthFundView, WealthSuggestion } from "@/lib/wealth/types";

const KIND_LABEL: Record<WealthSuggestion["kind"], string> = {
  event: "Events & news",
  efficiency: "Cash efficiency",
  yield_rotation: "Yield",
};

const KIND_CLASS: Record<WealthSuggestion["kind"], string> = {
  event: "bg-accent/15 text-accent-2",
  efficiency: "bg-positive/15 text-positive",
  yield_rotation: "bg-[#e0a53f]/15 text-[#e0a53f]",
};

export function SuggestionCard({
  suggestion: s,
  fund,
  onOpenFund,
}: {
  suggestion: WealthSuggestion;
  fund: WealthFundView | null;
  onOpenFund: (f: WealthFundView) => void;
}) {
  const asOfMs = Date.parse(s.asOf);
  return (
    <div className="flex flex-col rounded-lg border border-line bg-surface p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
            KIND_CLASS[s.kind],
          )}
        >
          {KIND_LABEL[s.kind]}
        </span>
        {Number.isFinite(asOfMs) && (
          <span className="text-[10px] text-fg-dim" title={s.asOf}>
            {fmtRelative(asOfMs)}
          </span>
        )}
      </div>

      <p className="text-[13.5px] font-medium leading-snug text-fg">{s.observation}</p>
      <p className="mt-1 text-[12.5px] leading-snug text-fg-muted">{s.option}</p>

      {s.riskNote && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-[#e0a53f]/30 bg-[#e0a53f]/10 px-2.5 py-1.5 text-[11px] text-[#e0a53f]">
          <span aria-hidden>⚠</span>
          <span>{s.riskNote}</span>
        </div>
      )}

      {/* Inputs — audited in the open. */}
      {s.inputs.length > 0 && (
        <div className="mt-2.5 rounded-md bg-surface-2/40 px-2.5 py-2">
          <div className="text-[9px] uppercase tracking-wider text-fg-dim">
            Based on
          </div>
          <ul className="mt-1 flex flex-col gap-0.5">
            {s.inputs.map((inp, i) => (
              <li
                key={i}
                className="font-[var(--font-jetbrains-mono)] text-[10.5px] leading-snug text-fg-muted"
              >
                · {inp}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Sources — linked events / news. */}
      {s.sources.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {s.sources.map((src, i) =>
            src.href ? (
              <a
                key={i}
                href={src.href}
                target={src.href.startsWith("/") ? undefined : "_blank"}
                rel="noopener noreferrer"
                className="truncate text-[11px] text-fg-muted underline decoration-dotted underline-offset-2 hover:text-fg"
              >
                ↗ {src.label}
              </a>
            ) : (
              <span key={i} className="truncate text-[11px] text-fg-dim">
                · {src.label}
              </span>
            ),
          )}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-line pt-2.5">
        <NotFinancialAdvice />
        <div className="flex items-center gap-2">
          {fund && (
            <button
              onClick={() => onOpenFund(fund)}
              className={buttonClass("ghost", "rounded px-2.5 py-1 text-[11px]")}
            >
              Details
            </button>
          )}
          {s.ctaHref && (
            <a
              href={s.ctaHref}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClass("primary", "rounded px-2.5 py-1 text-[11px]")}
            >
              {s.ctaLabel ?? "View on SoDEX"} ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
