import { Shell } from "@/components/layout/Shell";
import { PatternsDashboard } from "@/components/patterns/PatternsDashboard";

export default function PatternsPage() {
  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="text-xl font-semibold text-fg">Pattern Library</h1>
          <p className="text-sm text-fg-muted">
            Empirical impact stats: for each event_type, how often does the
            classified direction actually play out, and by how much. Drives
            dynamic conviction tuning so signals reflect what historically
            worked rather than hand-tuned guesses.
          </p>
        </header>

        <PatternsDashboard />
      </div>
    </Shell>
  );
}
