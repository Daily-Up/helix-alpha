import { Shell } from "@/components/layout/Shell";
import { SystemHealthDashboard } from "@/components/system-health/SystemHealthDashboard";

export default function SystemHealthPage() {
  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="text-xl font-semibold text-fg">System health</h1>
          <p className="text-sm text-fg-muted">
            Live deployment readiness. Last successful runs of every
            scheduled job, count of outcomes stuck pending past
            expiration, recent gate refusals grouped by rule, classifier
            error rate, and disk usage. Open alerts surface anything
            crossing a threshold (job stale, outcomes stuck, gate spike,
            classifier errors).
          </p>
        </header>
        <SystemHealthDashboard />
      </div>
    </Shell>
  );
}
