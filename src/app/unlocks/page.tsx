import { Shell } from "@/components/layout/Shell";
import { UnlocksDashboard } from "@/components/unlocks/UnlocksDashboard";

export const metadata = {
  title: "Token Unlocks · Helix",
  description:
    "Upcoming token supply unlocks and the short signals they generate.",
};

export default function UnlocksPage() {
  return (
    <Shell>
      <div className="dash-page-enter flex flex-col gap-5">
        <header>
          <h1 className="dash-title">Token Unlocks</h1>
          <p className="mt-2 dash-description">
            A forward calendar of scheduled token supply unlocks — and the
            short setups worth fading. The negative impact is front-loaded, so
            for large team / investor cliffs Helix plans a short into the
            anticipation (a week or two ahead) and a cover shortly after the
            unlock. Shortable candidates execute one-click on the perp, right
            here.
          </p>
          <p className="mt-3 text-[12px] text-fg-muted">
            Token economics (price, float, 24h volume, FDV) from SoSoValue;
            unlock dates from DefiLlama. Executes on SoDEX perps — their own
            trades, separate from Live Signals.
          </p>
        </header>

        <UnlocksDashboard />
      </div>
    </Shell>
  );
}
