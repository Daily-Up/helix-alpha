import { Shell } from "@/components/layout/Shell";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Cron } from "@/lib/db";
import { fmtRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function JobsPage() {
  const runs = Cron.recentRuns(50);
  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <h1 className="text-xl font-semibold text-fg">Cron & Audit Log</h1>

        <Card>
          <CardHeader>
            <CardTitle>Recent Runs</CardTitle>
            <div className="text-xs text-fg-muted">{runs.length} entries</div>
          </CardHeader>
          <CardBody className="p-0">
            <div className="divide-y divide-line">
              {runs.map((r) => {
                const status =
                  r.status === "ok"
                    ? "text-positive"
                    : r.status === "error"
                      ? "text-negative"
                      : "text-warning";
                return (
                  <div
                    key={r.id}
                    className="grid grid-cols-[60px_120px_90px_1fr_140px] items-center gap-3 px-4 py-2 text-xs"
                  >
                    <span className="tabular text-fg-dim">#{r.id}</span>
                    <span className="font-mono text-fg">{r.job}</span>
                    <span className={status}>● {r.status}</span>
                    <span className="truncate text-fg-muted">
                      {r.summary ?? r.error ?? "—"}
                    </span>
                    <span className="tabular text-right text-fg-dim">
                      {fmtRelative(r.started_at)}
                    </span>
                  </div>
                );
              })}
              {runs.length === 0 ? (
                <div className="p-6 text-center text-sm text-fg-muted">
                  No runs yet.
                </div>
              ) : null}
            </div>
          </CardBody>
        </Card>
      </div>
    </Shell>
  );
}
