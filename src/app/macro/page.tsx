import { Shell } from "@/components/layout/Shell";
import { MacroDashboard } from "@/components/macro/MacroDashboard";

export default function MacroPage() {
  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="text-xl font-semibold text-fg">Macro Bridge</h1>
          <p className="text-sm text-fg-muted">
            Macro calendar + historical prints with the &ldquo;surprise&rdquo;
            lens — actual vs forecast for every release. Cooler-than-expected
            inflation = bullish for risk; weaker activity = bearish. Sourced
            live from SoSoValue&apos;s
            <span className="font-mono text-fg"> /macro/events </span>
            and
            <span className="font-mono text-fg"> /history </span>
            endpoints; feeds the Daily Briefing.
          </p>
        </header>

        <MacroDashboard />
      </div>
    </Shell>
  );
}
