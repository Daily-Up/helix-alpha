import { Shell } from "@/components/layout/Shell";
import { StatsBar } from "@/components/events/StatsBar";
import { EventFeed } from "@/components/events/EventFeed";
import { RunIngestButton } from "@/components/events/RunIngestButton";

export default function EventsPage() {
  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <header className="flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold text-fg">Event Stream</h1>
            <p className="text-sm text-fg-muted">
              Every news event, AI-classified into event type / sentiment / severity / affected
              assets. Live signal layer for on-chain finance.
            </p>
          </div>
          <RunIngestButton />
        </header>

        <StatsBar />

        <EventFeed />
      </div>
    </Shell>
  );
}
