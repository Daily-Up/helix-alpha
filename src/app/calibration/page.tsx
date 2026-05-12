import { Shell } from "@/components/layout/Shell";
import { CalibrationDashboard } from "@/components/calibration/CalibrationDashboard";

export default function CalibrationPage() {
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
