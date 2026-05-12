import { Shell } from "@/components/layout/Shell";
import { EtfDashboard } from "@/components/etfs/EtfDashboard";

export default function EtfsPage() {
  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="text-xl font-semibold text-fg">ETF Flows</h1>
          <p className="text-sm text-fg-muted">
            Daily net inflows, AUM, and per-fund breakdown for spot ETFs across BTC,
            ETH, SOL, XRP, DOGE, LINK, LTC, HBAR, AVAX, DOT. Real SoSoValue data —
            not demo numbers.
          </p>
        </header>

        <EtfDashboard />
      </div>
    </Shell>
  );
}
