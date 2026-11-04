import { Shell } from "@/components/layout/Shell";
import { WealthDashboard } from "@/components/wealth/WealthDashboard";

export default function WealthIndexPage() {
  return (
    <Shell>
      <div className="dash-page-enter flex flex-col gap-5">
        <header>
          <h1 className="dash-title">Wealth Index</h1>
          <p className="mt-2 dash-description">
            A Helix lens over SoDEX Wealth — on-chain yield and tokenised
            real-world assets. Browse the live catalog (Stable Earn, Curated
            ETFs, Specialty vaults), track your wealth holdings, and get
            factual, input-grounded suggestions driven by Helix&apos;s event
            stream and each fund&apos;s news. Read-only — invest, subscribe and
            redeem on SoDEX. Not financial advice.
          </p>
        </header>

        <WealthDashboard />
      </div>
    </Shell>
  );
}
