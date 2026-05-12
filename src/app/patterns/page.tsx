import { Shell } from "@/components/layout/Shell";
import { PatternsDashboard } from "@/components/patterns/PatternsDashboard";
import { WavePlaceholder } from "@/components/layout/WavePlaceholder";
import { isPublicMode } from "@/lib/public-mode";

export default function PatternsPage() {
  if (isPublicMode()) {
    return (
      <Shell>
        <WavePlaceholder
          title="Pattern Library"
          wave="Wave 2"
          description="Empirical impact stats per event_type — how often the
          classified direction actually plays out, and by how much. The
          sample per (event_type × asset_class) cell is still thin; the
          page goes live once each cell crosses a meaningful sample size
          so the patterns aren't just noise."
          features={[
            "Per event_type: hit rate, mean realized move, median realized move",
            "Drilldown by asset class (large-cap crypto vs equities vs RWAs vs index funds)",
            "Drives dynamic conviction tuning — signals reflect what historically worked rather than hand-tuned weights",
            "Cross-validated against the calibration page so the two stay in agreement",
          ]}
        />
      </Shell>
    );
  }
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
