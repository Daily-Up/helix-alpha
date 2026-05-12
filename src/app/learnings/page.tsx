import { Shell } from "@/components/layout/Shell";
import { LearningsDashboard } from "@/components/learnings/LearningsDashboard";

export default function LearningsPage() {
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
