import { Shell } from "@/components/layout/Shell";
import { SignalsDashboard } from "@/components/signals/SignalsDashboard";

export default function SignalsPage() {
  return (
    <Shell>
      <div className="dash-page-enter flex flex-col gap-5">
        <header>
          <h1 className="dash-title">Live Signals</h1>
          <p className="mt-2 dash-description">
            AI-generated trade signals from classified events × tradable
            assets. Three tiers: Auto (≥75% conviction, fires automatically
            when enabled), Review (≥50%, one-click approval), Info (≥30%,
            informational only). Each signal carries pipeline metadata —
            catalyst subtype, asset relevance, lifecycle, source tier —
            visible on hover.
          </p>
          <p className="mt-3 text-[12px] text-fg-muted">
            <a
              className="underline decoration-dotted underline-offset-4 hover:text-fg"
              href="/signals/performance"
            >
              See realized performance →
            </a>
            <span className="mx-3 text-fg-dim">·</span>
            <span>
              Demo mode is the default — connect a SoDEX wallet via the
              badge in the top bar to enable LIVE execution.
            </span>
          </p>
        </header>

        <SignalsDashboard />
      </div>
    </Shell>
  );
}
