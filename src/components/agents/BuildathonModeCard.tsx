/**
 * "Buildathon mode" explainer.
 *
 * Shown on the audit page next to the agent trace cards and on the
 * /agents page header. Explains to a visitor (judge, reviewer, user)
 * that the agentic layer is built but doesn't run 24/7 — running every
 * incoming news headline through a multi-step agent would push the
 * Anthropic bill way past what makes sense for a buildathon
 * submission.
 *
 * The "Run live agent" button (when present) hits the public demo
 * endpoint, which has a rate limit + daily spend cap built in so
 * anyone can click without burning the operator's budget.
 */

import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

export function BuildathonModeCard({
  variant = "audit",
}: {
  variant?: "audit" | "agents";
}) {
  return (
    <Card>
      <CardHeader className="flex-col items-stretch gap-1">
        <div className="flex items-center gap-2">
          <CardTitle>Buildathon mode</CardTitle>
          <Badge tone="accent">WAVE 2</Badge>
        </div>
      </CardHeader>
      <CardBody>
        <p className="text-xs text-fg-muted">
          {variant === "audit" ? (
            <>
              The agentic layer below is the Wave 2 build. In production
              we&apos;d route every classified event through the research
              agent — but a multi-step, tool-using agent costs roughly
              <span className="mx-1 font-mono">$0.04</span> per
              classification, and the news firehose averages 30+
              classifications per hour. Running it 24/7 against the live
              feed would cost{" "}
              <span className="font-mono">~$25–30 / day</span> in
              Anthropic API alone — not the right call for a buildathon
              submission.
            </>
          ) : (
            <>
              The agentic layer is built and deployed but not auto-running
              on the live news feed. Routing every incoming classification
              through a tool-using agent costs about{" "}
              <span className="font-mono">$0.04</span> each — and with the
              ingest cron firing every 15 minutes, leaving it on 24/7
              would burn <span className="font-mono">~$25–30 / day</span>.
              Reasonable cost discipline for a buildathon means triggering
              the agent on-demand instead.
            </>
          )}
        </p>
        <p className="mt-2 text-xs text-fg-muted">
          The <span className="font-mono">Run live agent</span> button hits
          a public endpoint with a built-in rate limit (one run per 30s)
          and daily spend cap (
          <span className="font-mono">$3 / day</span>), so anyone reading
          this can demo it. Every run persists to{" "}
          <span className="font-mono">agent_traces</span> and shows up
          alongside the rest.
        </p>
      </CardBody>
    </Card>
  );
}
