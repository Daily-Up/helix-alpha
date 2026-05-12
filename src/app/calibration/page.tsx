import { Shell } from "@/components/layout/Shell";
import { CalibrationDashboard } from "@/components/calibration/CalibrationDashboard";
import { WavePlaceholder } from "@/components/layout/WavePlaceholder";
import { isPublicMode } from "@/lib/public-mode";

export default function CalibrationPage() {
  if (isPublicMode()) {
    return (
      <Shell>
        <WavePlaceholder
          title="Calibration"
          wave="Wave 2"
          description="Observability layer that grades the pipeline against itself once
          enough signals have resolved. Goes live in Wave 2, when the
          sample size per (tier × catalyst subtype) crosses the threshold
          needed for a meaningful hit-rate read."
          features={[
            "Hit rate by tier — auto / review / info — over a rolling window",
            "Hit rate by catalyst subtype × asset class, so we can see which event types actually move which markets",
            "Conviction calibration curve (stated vs realized) — checks the conviction score is itself well-calibrated",
            "Best winners and worst losers forensics list, with full audit links",
            "v1 vs v2.1 framework attribution, once v2.1 has shipped",
          ]}
        />
      </Shell>
    );
  }
  return (
    <Shell>
      <div className="dash-page-enter flex flex-col gap-5">
        <header>
          <h1 className="dash-title">Calibration</h1>
          <p className="mt-2 dash-description">
            What actually happens to signals after they fire. Five panels:
            tier hit rate, catalyst subtype hit rate, conviction
            calibration curve, PnL by (subtype × asset class), and the
            forensics list of best winners + worst losers. Read-only —
            this page observes the pipeline, it doesn&apos;t alter it.
          </p>
        </header>
        <CalibrationDashboard />
      </div>
    </Shell>
  );
}
