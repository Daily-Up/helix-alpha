import { Shell } from "@/components/layout/Shell";
import { SectorDashboard } from "@/components/sectors/SectorDashboard";

export default function SectorsPage() {
  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="text-xl font-semibold text-fg">Sector Rotation</h1>
          <p className="text-sm text-fg-muted">
            Where is capital sitting (sector dominance) and where is it moving
            (SSI index momentum). The narrative cycle clock — DeFi → AI → Meme
            → RWA → back to BTC.
          </p>
        </header>

        <SectorDashboard />
      </div>
    </Shell>
  );
}
