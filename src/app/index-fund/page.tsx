import { Shell } from "@/components/layout/Shell";
import { IndexDashboard } from "@/components/index-fund/IndexDashboard";

export default function IndexFundPage() {
  return (
    <Shell>
      <div className="dash-page-enter flex flex-col gap-5">
        <header>
          <h1 className="dash-title">AlphaIndex</h1>
          <p className="mt-2 dash-description">
            One-person BlackRock. AI-managed multi-asset index that allocates
            across crypto majors (BTC/ETH/HYPE), mega-cap equities (NVDA/GOOGL/
            MSFT), gold and SoSoValue index products — weighted by news signals,
            30-day momentum, and SoSoValue ETF-flow fundamentals. Rebalance
            reasoning written by Claude. Paper trades — real SoDEX prices,
            simulated fills.
          </p>
        </header>

        <IndexDashboard />
      </div>
    </Shell>
  );
}
