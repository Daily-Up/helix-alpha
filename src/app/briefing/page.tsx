import { Shell } from "@/components/layout/Shell";
import { BriefingPage } from "@/components/briefing/BriefingPage";

export default function Briefing() {
  return (
    <Shell>
      <div className="dash-page-enter flex flex-col gap-5">
        <header>
          <h1 className="dash-title">Daily AI Briefing</h1>
          <p className="mt-2 dash-description">
            Once a day Claude reads pending signals, sector rotation, ETF
            flows, AlphaIndex positions, and the macro calendar — then writes
            a 3-paragraph market read with a single highest-conviction trade
            idea. Your tape, summarised.
          </p>
        </header>

        <BriefingPage />
      </div>
    </Shell>
  );
}
