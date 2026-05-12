import { Shell } from "@/components/layout/Shell";
import { SignalAuditPage } from "@/components/signals/SignalAuditPage";

export default async function SignalAudit({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Shell>
      <SignalAuditPage signalId={id} />
    </Shell>
  );
}
