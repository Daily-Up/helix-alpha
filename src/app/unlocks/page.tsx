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
            A forward calendar of scheduled token supply unlocks. A large
            cliff — sized as a share of circulating float — is predictable,
            datable sell pressure, so Helix fires a SHORT into it on the perp.
            Each shortable unlock links straight to a one-click trade.
          </p>
          <p className="mt-3 text-[12px] text-fg-muted">
            <span>
              Data: DefiLlama emissions. Shorts execute on SoDEX perps from{" "}
            </span>
            <a
              className="underline decoration-dotted underline-offset-4 hover:text-fg"
              href="/signals"
            >
              Live Signals →
            </a>
          </p>
        </header>

        <UnlocksDashboard />
      </div>
    </Shell>
  );
}
