import { Shell } from "@/components/layout/Shell";
import { TreasuriesDashboard } from "@/components/treasuries/TreasuriesDashboard";

export default function TreasuriesPage() {
  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="text-xl font-semibold text-fg">Treasury Watch</h1>
          <p className="text-sm text-fg-muted">
            Public companies holding BTC on balance sheet — corporate
            accumulation as a smart-money lens. Sourced live from SoSoValue&apos;s
            <span className="font-mono text-fg"> /btc-treasuries </span>
            ledger. The Daily Briefing reads this surface alongside ETF
            flows and pending signals.
          </p>
        </header>

        <TreasuriesDashboard />
      </div>
    </Shell>
  );
}
