/**
 * Public-facing placeholder for pages whose underlying *page logic* exists
 * in code but whose data or calibration is still maturing. Surfaced in
 * production via the public-mode flag; locally the real page renders so
 * we can keep building.
 *
 * The wave label communicates honest scope: "Wave 2" / "Wave 3" tells
 * judges what's planned without overpromising.
 */
interface WavePlaceholderProps {
  /** e.g. "Calibration", "Learnings", "Pattern Library". */
  title: string;
  /** "Wave 2" or "Wave 3" — when this page goes live publicly. */
  wave: string;
  /** Plain-language explanation: why it's not ready, what it'll show. */
  description: string;
  /** Short bullets listing what the page will surface once shipped. */
  features?: string[];
}

export function WavePlaceholder({
  title,
  wave,
  description,
  features,
}: WavePlaceholderProps) {
  return (
    <div className="dash-page-enter flex flex-col gap-6">
      <header>
        <div className="flex items-baseline gap-3">
          <h1 className="dash-title">{title}</h1>
          <span
            className="rounded bg-accent/15 px-2 py-0.5 font-[var(--font-jetbrains-mono)] text-[10px] uppercase text-accent-2"
            style={{ letterSpacing: "0.16em" }}
          >
            {wave}
          </span>
        </div>
      </header>

      <section
        className="rounded border border-line bg-surface p-8"
        style={{ maxWidth: "720px" }}
      >
        <div
          className="font-[var(--font-jetbrains-mono)] uppercase text-accent-2"
          style={{
            fontSize: "11px",
            letterSpacing: "0.22em",
            marginBottom: "14px",
          }}
        >
          Shipping in {wave}
        </div>
        <p
          className="font-[var(--font-inter)] text-fg"
          style={{ fontSize: "16px", lineHeight: 1.6 }}
        >
          {description}
        </p>
        {features && features.length > 0 ? (
          <ul className="mt-6 flex flex-col gap-2">
            {features.map((f) => (
              <li
                key={f}
                className="flex items-start gap-3 font-[var(--font-inter)] text-fg-muted"
                style={{ fontSize: "14px", lineHeight: 1.55 }}
              >
                <span
                  className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  aria-hidden
                />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
