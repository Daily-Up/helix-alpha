import { Shell } from "@/components/layout/Shell";
import { EventStream } from "@/components/events/EventStream";

export const dynamic = "force-dynamic";

export default function EventsPage() {
  return (
    <Shell>
      <EventStream />
    </Shell>
  );
}
