import { Shell } from "@/components/layout/Shell";
import { IndexDashboard } from "@/components/index-fund/IndexDashboard";

export default function IndexFundPage() {
  return (
    <Shell>
      <div className="dash-page-enter flex flex-col gap-5">
        <header>
          <h1 className="dash-title">AlphaIndex</h1>
          <p className="mt-2 dash-description">
            One-person BlackRock. AI-managed crypto index that allocates
            across BTC/ETH/L1s/RWA/sector indexes/perps based on accumulated
            news signals, sector momentum, and ETF flows. Rebalance reasoning
            written by Claude. Paper trades — real SoDEX prices, simulated
            fills.
          </p>
        </header>

        <IndexDashboard />
      </div>
    </Shell>
  );
}
