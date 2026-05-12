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
        </header>

        <SignalsDashboard />
      </div>
    </Shell>
  );
}
