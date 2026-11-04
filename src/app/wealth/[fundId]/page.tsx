import { Shell } from "@/components/layout/Shell";
import { FundDetailPage } from "@/components/wealth/FundDetailPage";

export default async function WealthFundPage({
  params,
}: {
  params: Promise<{ fundId: string }>;
}) {
  const { fundId } = await params;
  return (
    <Shell>
      <div className="dash-page-enter">
        <FundDetailPage fundId={fundId} />
      </div>
    </Shell>
  );
}
