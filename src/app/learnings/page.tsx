import { Shell } from "@/components/layout/Shell";
import { LearningsDashboard } from "@/components/learnings/LearningsDashboard";
import { WavePlaceholder } from "@/components/layout/WavePlaceholder";
import { isPublicMode } from "@/lib/public-mode";

export default function LearningsPage() {
  if (isPublicMode()) {
    return (
      <Shell>
        <WavePlaceholder
          title="Learnings"
          wave="Wave 2 / Wave 3"
          description="How well our signals actually called market moves. Becomes
          meaningful once enough resolved signals are on file — until
          then a hit rate is just noise. Ships fully when the resolved
          sample crosses the threshold."
          features={[
            "Hit rate per (catalyst subtype × asset class) on resolved signals",
            "Average directional PnL by tier — read-only audit of what the pipeline produced",
            "Worst losers timeline, so we can see what kinds of events the classifier mis-prices",
            "Replays the v1 vs v2.1 framework side by side once both have data",
          ]}
        />
      </Shell>
    );
  }
  return (
    <Shell>
      <div className="dash-page-enter flex flex-col gap-5">
        <header>
          <h1 className="dash-title">Learnings</h1>
          <p className="mt-2 dash-description">
            How well your signals actually called market moves. Hit rate
            is the share of signals where the directional move agreed
            with the call. Avg PnL is the directional impact (+long,
            −short) averaged across signals — not trade P&amp;L.
          </p>
        </header>

        <LearningsDashboard />
      </div>
    </Shell>
  );
}
