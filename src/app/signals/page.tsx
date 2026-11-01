import { Shell } from "@/components/layout/Shell";
import { SignalsDashboard } from "@/components/signals/SignalsDashboard";

export default function SignalsPage() {
  return (
    <Shell>
      <div className="dash-page-enter flex flex-col gap-5">
        <header>
          <h1 className="dash-title">Live Signals</h1>
          <p className="mt-2 dash-description">
            Trade ideas the moment a catalyst breaks — each with a clear
            direction, entry, target, stop, and the reason behind it. Every
            signal is scored against what actually happened.
          </p>
          <p className="mt-3 text-[12px] text-fg-muted">
            Connect a SoDEX wallet from the top bar to execute live.
          </p>
        </header>

        <SignalsDashboard />
      </div>
    </Shell>
  );
}
