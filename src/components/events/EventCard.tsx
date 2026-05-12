import { fmtRelative, truncate } from "@/lib/format";

export interface EventCardData {
  id: string;
  release_time: number;
  title: string;
  author: string | null;
  source_link: string | null;
  matched_currencies: Array<{ symbol: string }>;
  // Classification fields (may be null if not yet classified)
  event_type: string | null;
  sentiment: "positive" | "negative" | "neutral" | null;
  severity: "high" | "medium" | "low" | null;
  confidence: number | null;
  affected_asset_ids: string[];
  reasoning: string | null;
  // Skip metadata (Phase G) — set when the event was gated out before
  // Claude saw it. When present, the card renders as "Skipped" with a
  // typed reason rather than "Pending — awaiting Claude". Lets the user
  // distinguish "system decided not to classify" from "system hasn't
  // gotten to it yet".
  skip_reasoning?: string | null;
  skip_score?: number | null;
}

// Editorial palette — match SignalCard / HeroStat.
const TEXT_BRAND = "#ede4d3";
const TEXT_MUTED = "#8a857a";
const TEXT_DIM = "#5d584e";
const POSITIVE = "#5cc97a";
const NEGATIVE = "#e06c66";
const WARNING = "#d1a85a";
const ACCENT = "#d97757";
const BORDER_QUIET = "rgba(237, 228, 211, 0.08)";

const sentimentColor: Record<NonNullable<EventCardData["sentiment"]>, string> = {
  positive: POSITIVE,
  negative: NEGATIVE,
  neutral: TEXT_DIM,
};

const severityColor: Record<NonNullable<EventCardData["severity"]>, string> = {
  high: NEGATIVE,
  medium: WARNING,
  low: TEXT_DIM,
};

/**
 * Editorial event card — matches the SignalCard idiom (kicker → headline →
 * standfirst → dateline) so the Event Stream reads as the same publication
 * as the rest of the dashboard. Replaces the rounded-md + bg-surface chip
 * box that gave it a Bloomberg-terminal feel.
 */
export function EventCard({ ev }: { ev: EventCardData }) {
  const classified = !!ev.event_type;
  const skipped = !classified && !!ev.skip_reasoning;
  const pending = !classified && !skipped;
  // Classified → solid coloured rail.
  // Skipped → solid muted rail (decision made, just not classified).
  // Pending → dashed rail (decision pending).
  const sentimentRail =
    ev.sentiment != null ? sentimentColor[ev.sentiment] : TEXT_DIM;
  const railStyle = pending ? "dashed" : "solid";

  // Parse the skip reason into a short, user-readable label.
  // Reasoning strings we produce:
  //   "score 0.13 < 0.15 — no corpus shape..." → "below corpus threshold"
  //   "backlog_skip — fast-forward..."           → "backlog skip"
  const skipKind: "corpus" | "backlog" | "other" = !skipped
    ? "other"
    : (ev.skip_reasoning ?? "").includes("backlog_skip")
      ? "backlog"
      : (ev.skip_reasoning ?? "").includes("corpus")
        ? "corpus"
        : "other";

  return (
    <article
      className="relative flex flex-col py-5"
      style={{
        borderTop: `1px solid ${BORDER_QUIET}`,
        paddingLeft: "24px",
        paddingRight: "8px",
      }}
    >
      {/* Sentiment-coloured rail. Dashed for unclassified (still in flight). */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          top: "20px",
          bottom: "20px",
          width: "2px",
          ...(railStyle === "solid"
            ? { background: sentimentRail }
            : {
                borderLeft: `2px dashed ${sentimentRail}`,
                background: "transparent",
              }),
          opacity: classified ? 0.85 : 0.7,
        }}
      />

      {/* Kicker — event_type · sentiment · severity · confidence */}
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {classified ? (
          <>
            <span
              className="font-[var(--font-jetbrains-mono)] uppercase"
              style={{
                fontSize: "10px",
                fontWeight: 600,
                letterSpacing: "0.22em",
                color: ACCENT,
              }}
            >
              {ev.event_type}
            </span>
            <span style={{ color: TEXT_DIM, fontSize: "11px" }}>·</span>
            <span
              className="font-[var(--font-jetbrains-mono)] uppercase"
              style={{
                fontSize: "10px",
                fontWeight: 600,
                letterSpacing: "0.22em",
                color: ev.sentiment ? sentimentColor[ev.sentiment] : TEXT_DIM,
              }}
            >
              {ev.sentiment}
            </span>
            <span style={{ color: TEXT_DIM, fontSize: "11px" }}>·</span>
            <span
              className="font-[var(--font-jetbrains-mono)] uppercase"
              style={{
                fontSize: "10px",
                letterSpacing: "0.18em",
                color: ev.severity ? severityColor[ev.severity] : TEXT_DIM,
              }}
            >
              sev {ev.severity}
            </span>
            <span
              className="font-[var(--font-jetbrains-mono)] tabular-nums"
              style={{
                fontSize: "10px",
                letterSpacing: "0.12em",
                color: TEXT_MUTED,
              }}
            >
              · {((ev.confidence ?? 0) * 100).toFixed(0)}% CONF
            </span>
          </>
        ) : skipped ? (
          <>
            <span
              className="font-[var(--font-jetbrains-mono)] uppercase"
              style={{
                fontSize: "10px",
                fontWeight: 600,
                letterSpacing: "0.22em",
                color: TEXT_DIM,
              }}
            >
              Skipped
            </span>
            <span style={{ color: TEXT_DIM, fontSize: "11px" }}>·</span>
            <span
              className="font-[var(--font-jetbrains-mono)] uppercase"
              style={{
                fontSize: "10px",
                letterSpacing: "0.18em",
                color: TEXT_DIM,
              }}
            >
              {skipKind === "backlog"
                ? "backlog sweep"
                : skipKind === "corpus"
                  ? "below corpus threshold"
                  : "pre-classify gate"}
            </span>
            {ev.skip_score != null && skipKind === "corpus" ? (
              <span
                className="font-[var(--font-jetbrains-mono)] tabular-nums"
                style={{
                  fontSize: "10px",
                  letterSpacing: "0.12em",
                  color: TEXT_DIM,
                }}
              >
                · score {ev.skip_score.toFixed(2)}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span
              className="font-[var(--font-jetbrains-mono)] uppercase"
              style={{
                fontSize: "10px",
                fontWeight: 600,
                letterSpacing: "0.22em",
                color: TEXT_DIM,
              }}
            >
              Pending
            </span>
            <span style={{ color: TEXT_DIM, fontSize: "11px" }}>·</span>
            <span
              className="font-[var(--font-jetbrains-mono)] uppercase animate-pulse"
              style={{
                fontSize: "10px",
                letterSpacing: "0.18em",
                color: TEXT_MUTED,
              }}
            >
              awaiting Claude
            </span>
          </>
        )}
        <span
          className="ml-auto font-[var(--font-inter)] tabular-nums"
          style={{ fontSize: "11px", color: TEXT_DIM }}
        >
          {fmtRelative(ev.release_time)}
        </span>
      </div>

      {/* Headline — clickable to source. */}
      {ev.source_link ? (
        <h3
          className="font-[var(--font-fraunces)]"
          style={{
            fontSize: "17px",
            fontWeight: 400,
            lineHeight: 1.3,
            letterSpacing: "-0.012em",
            marginBottom: "8px",
            maxWidth: "70ch",
          }}
        >
          <a
            href={ev.source_link}
            target="_blank"
            rel="noopener noreferrer"
            className="signal-headline-link"
            style={{
              color: TEXT_BRAND,
              textDecoration: "none",
              display: "inline-block",
            }}
            title="Open source article"
          >
            {ev.title}
          </a>
        </h3>
      ) : (
        <h3
          className="font-[var(--font-fraunces)]"
          style={{
            fontSize: "17px",
            fontWeight: 400,
            lineHeight: 1.3,
            letterSpacing: "-0.012em",
            color: TEXT_BRAND,
            marginBottom: "8px",
            maxWidth: "70ch",
          }}
        >
          {ev.title}
        </h3>
      )}

      {/* Reasoning standfirst — one paragraph, capped. Placeholder for
          unclassified events so the card has consistent vertical rhythm
          with classified neighbours and doesn't look stubby. */}
      {ev.reasoning ? (
        <p
          className="font-[var(--font-inter)]"
          style={{
            fontSize: "12.5px",
            lineHeight: 1.6,
            color: TEXT_MUTED,
            marginBottom: "8px",
            maxWidth: "70ch",
          }}
        >
          {truncate(ev.reasoning, 260)}
        </p>
      ) : skipped ? (
        <p
          className="font-[var(--font-inter)]"
          style={{
            fontSize: "12.5px",
            lineHeight: 1.6,
            color: TEXT_DIM,
            marginBottom: "8px",
            maxWidth: "70ch",
            fontStyle: "italic",
          }}
        >
          {skipKind === "backlog"
            ? "Older event — skipped during real-time fast-forward. The system kept the newest pending events for Claude and bypassed historical noise. Use the reclassify endpoint to backfill if needed."
            : skipKind === "corpus"
              ? "Headline didn't structurally match any of the 95 historical signals in the calibration corpus. No tokens spent on classification."
              : "Skipped at the pre-classify gate before reaching Claude."}
        </p>
      ) : (
        <p
          className="font-[var(--font-inter)]"
          style={{
            fontSize: "12.5px",
            lineHeight: 1.6,
            color: TEXT_DIM,
            marginBottom: "8px",
            maxWidth: "70ch",
            fontStyle: "italic",
          }}
        >
          Pending classification — Claude will tag this event with
          type / sentiment / severity / affected assets on the next
          cycle.
        </p>
      )}

      {/* Footer — affects + author, mono small caps. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {ev.affected_asset_ids.length > 0 || ev.matched_currencies.length > 0 ? (
          <span
            className="font-[var(--font-jetbrains-mono)] uppercase"
            style={{
              fontSize: "10px",
              letterSpacing: "0.16em",
              color: TEXT_DIM,
            }}
          >
            Affects{" "}
            <span style={{ color: TEXT_MUTED, letterSpacing: "0.04em" }}>
              {(ev.affected_asset_ids.length > 0
                ? ev.affected_asset_ids
                : ev.matched_currencies.map((c) => c.symbol)
              )
                .slice(0, 8)
                .join(" · ")}
            </span>
          </span>
        ) : null}
        {ev.author ? (
          <span
            className="font-[var(--font-jetbrains-mono)] uppercase ml-auto"
            style={{
              fontSize: "10px",
              letterSpacing: "0.16em",
              color: TEXT_DIM,
            }}
          >
            via {ev.author}
          </span>
        ) : null}
      </div>
    </article>
  );
}
