import { Shell } from "@/components/layout/Shell";
import { AgentsDashboard } from "@/components/agents/AgentsDashboard";

export const dynamic = "force-dynamic";

export default function AgentsPage() {
  return (
    <Shell>
      <AgentsDashboard />
    </Shell>
  );
}
