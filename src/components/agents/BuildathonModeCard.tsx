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
              agent automatically. For this buildathon submission, agents
              run on-demand — click <span className="font-mono">Run live
              agent</span> to trigger one now and watch its full reasoning
              chain.
            </>
          ) : (
            <>
              The agentic layer is built and deployed but not auto-running
              on the live news feed. Agents are triggered on-demand so you
              can step through their decisions one signal at a time.
            </>
          )}
        </p>
        <p className="mt-2 text-xs text-fg-muted">
          Every run persists and shows up in the trace history — each
          step (tool call, tool result, final classification) is
          recorded, auditable, and replayable.
        </p>
      </CardBody>
    </Card>
  );
}
