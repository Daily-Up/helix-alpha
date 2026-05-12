import { Shell } from "@/components/layout/Shell";
import { PortfolioDashboard } from "@/components/portfolio/PortfolioDashboard";

export default function PortfolioPage() {
  return (
    <Shell>
      <div className="dash-page-enter flex flex-col gap-5">
        <header>
          <h1 className="dash-title">Paper Portfolio</h1>
          <p className="mt-2 dash-description">
            Simulated trades. Real SoDEX prices, simulated fills. Equity
            marked-to-market every 10 seconds against live tickers.
          </p>
        </header>

        <PortfolioDashboard />
      </div>
    </Shell>
  );
}
