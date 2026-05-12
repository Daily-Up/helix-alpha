"use client";

/**
 * /briefing — the Daily AI Briefing.
 *
 * Renders the latest Claude-synthesized market read (headline + regime +
 * 3-paragraph body + top pick + watchlist) plus a transparency footer
 * showing exactly what data the AI consumed. Below, an archive of past
 * days lets the user track how the system has been reading the tape.
 */

import { useEffect, useState } from "react";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { useBulkMountReveal } from "@/hooks/useMountReveal";
import {
  fmtPrice,
  fmtRelative,
  fmtSodexSymbol,
  fmtUntil,
} from "@/lib/format";
import { cn } from "@/components/ui/cn";

// Editorial design tokens — keep in sync with HeroStat + SignalCard.
const TEXT_BRAND = "#ede4d3";
const TEXT_MUTED = "#8a857a";
const TEXT_DIM = "#5d584e";
const ACCENT = "#d97757";
const POSITIVE = "#5cc97a";
const NEGATIVE = "#e06c66";
const WARNING = "#d1a85a";
const BORDER_QUIET = "rgba(237, 228, 211, 0.08)";

type Regime = "risk_on" | "risk_off" | "mixed" | "neutral";

interface TopPick {
  asset_id: string;
  asset_symbol: string;
  direction: "long" | "short" | "watch";
  thesis: string;
  conviction: number;
}

interface WatchlistEntry {
  asset_id: string;
  symbol: string;
  note: string;
}

interface BriefingInputsSummary {
  pending_signals: number;
  classifications_24h: number;
  top_event_types: Array<{ event_type: string; n: number }>;
  alphaindex_top_positions: Array<{ symbol: string; weight_pct: number }>;
  sector_top: Array<{ name: string; change_24h_pct: number }>;
  sector_bottom: Array<{ name: string; change_24h_pct: number }>;
  etf_net_flow_24h_usd: number | null;
  best_event_type_hit_rate: {
    event_type: string;
    hit_rate_3d: number | null;
    n: number;
  } | null;
  treasury_summary: {
    acquiring_companies: number;
    net_btc_acquired: number;
    total_acq_cost_usd: number | null;
    total_btc_held_latest: number;
  } | null;
}

interface BriefingRow {
  date: string;
  generated_at: number;
  headline: string;
  regime: Regime;
  body: string;
  top_pick: TopPick | null;
  watchlist: WatchlistEntry[];
  inputs_summary: BriefingInputsSummary;
  model: string;
  prompt_version: string;
  tokens_input: number;
  tokens_output: number;
  tokens_cached: number;
  cost_usd: number;
}

/** Attached by /api/data/briefing — concrete trade levels for the top pick. */
interface TopPickTrade {
  signal_id: string;
  tier: "auto" | "review" | "info";
  catalyst_subtype: string | null;
  entry_price: number | null;
  stop_pct: number | null;
  target_pct: number | null;
  size_usd: number | null;
  expected_horizon: string | null;
  expires_at: number | null;
  asset_relevance: number | null;
  source_tier: number | null;
  sodex_symbol: string;
  stop_price: number | null;
  target_price: number | null;
  rr_ratio: number | null;
  backtest: {
    sample_size: number;
    avg_impact_1d_pct: number | null;
    avg_impact_3d_pct: number | null;
    hit_rate_1d_pct: number | null;
    expected_direction: "up" | "down" | "either";
    event_type: string;
    sentiment: string;
  } | null;
}

const REGIME_META: Record<
  Regime,
  { label: string; color: string }
> = {
  risk_on: { label: "RISK-ON", color: POSITIVE },
  risk_off: { label: "RISK-OFF", color: NEGATIVE },
  mixed: { label: "MIXED", color: WARNING },
  neutral: { label: "NEUTRAL", color: TEXT_MUTED },
};

function fmtUsdCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${n < 0 ? "-" : ""}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${n < 0 ? "-" : ""}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${n < 0 ? "-" : ""}$${(abs / 1e3).toFixed(1)}K`;
  return `${n < 0 ? "-" : ""}$${abs.toFixed(0)}`;
}

export function BriefingPage() {
  const [latest, setLatest] = useState<BriefingRow | null>(null);
  const [topPickTrade, setTopPickTrade] = useState<TopPickTrade | null>(null);
  const [archive, setArchive] = useState<BriefingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setError(null);
    const r = await fetch("/api/data/briefing");
    const j = await r.json();
    setLatest(j.latest);
    setTopPickTrade(j.top_pick_trade ?? null);
    setArchive(j.archive ?? []);
  };

  useEffect(() => {
    fetchData().finally(() => setLoading(false));
  }, []);

  const generateNow = async (force = false) => {
    setGenerating(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/cron/generate-briefing${force ? "?force=1" : ""}`,
        { method: "POST" },
      );
      const j = await r.json();
      if (!j.ok) {
        setError(j.error ?? "generation failed");
      } else {
        await fetchData();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setGenerating(false);
    }
  };

  const revealRef = useBulkMountReveal();

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <PanelSkeleton height="h-64" />
        <PanelSkeleton height="h-32" />
      </div>
    );
  }

  return (
    <div ref={revealRef} className="dash-crossfade-enter flex flex-col gap-10">
      {/* No briefing yet — editorial empty state */}
      {!latest ? (
        <div
          className="flex flex-col items-start gap-4 py-12"
          style={{ borderTop: `1px solid ${BORDER_QUIET}`, paddingLeft: "26px" }}
        >
          <div
            className="font-[var(--font-jetbrains-mono)] uppercase"
            style={{
              fontSize: "10px",
              fontWeight: 600,
              letterSpacing: "0.22em",
              color: ACCENT,
            }}
          >
            Awaiting today&apos;s briefing
          </div>
          <h2
            className="font-[var(--font-fraunces)]"
            style={{
              fontSize: "28px",
              fontWeight: 400,
              lineHeight: 1.22,
              letterSpacing: "-0.02em",
              color: TEXT_BRAND,
              maxWidth: "60ch",
            }}
          >
            Today&apos;s tape, summarised.
          </h2>
          <p
            className="font-[var(--font-inter)]"
            style={{
              fontSize: "13.5px",
              lineHeight: 1.7,
              color: TEXT_MUTED,
              maxWidth: "60ch",
            }}
          >
            Claude reads pending signals, sector rotation, ETF flows,
            AlphaIndex positions, and the macro calendar — then writes a
            3-paragraph market read with a single highest-conviction trade
            idea.
          </p>
          <button
            onClick={() => generateNow(false)}
            disabled={generating}
            className="font-[var(--font-jetbrains-mono)] transition-all"
            style={{
              fontSize: "11px",
              fontWeight: 600,
              letterSpacing: "0.18em",
              padding: "9px 20px",
              border: `1px solid ${generating ? BORDER_QUIET : ACCENT}`,
              color: generating ? TEXT_DIM : ACCENT,
              background: generating ? "transparent" : "rgba(217, 119, 87, 0.06)",
              cursor: generating ? "wait" : "pointer",
              textTransform: "uppercase",
              borderRadius: "2px",
              marginTop: "8px",
            }}
          >
            {generating ? "Generating…" : "Generate today's briefing →"}
          </button>
          {error ? (
            <span
              className="font-[var(--font-inter)]"
              style={{ fontSize: "12px", color: NEGATIVE }}
            >
              {error}
            </span>
          ) : null}
        </div>
      ) : (
        <BriefingHero
          briefing={latest}
          topPickTrade={topPickTrade}
          onRegenerate={() => generateNow(true)}
          regenerating={generating}
        />
      )}

      {error && latest ? (
        <div
          className="font-[var(--font-inter)]"
          style={{
            fontSize: "12px",
            color: NEGATIVE,
            fontStyle: "italic",
          }}
        >
          {error}
        </div>
      ) : null}

      {/* Archive */}
      {archive.length > 0 ? (
        <div>
          <div
            className="font-[var(--font-jetbrains-mono)] uppercase"
            style={{
              fontSize: "10px",
              fontWeight: 600,
              letterSpacing: "0.22em",
              color: TEXT_MUTED,
              marginBottom: "16px",
            }}
          >
            Previous briefings
          </div>
          <div className="flex flex-col">
            {archive.map((b) => (
              <ArchiveRow key={b.date} briefing={b} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Hero — today's briefing (or whichever is latest)
// ─────────────────────────────────────────────────────────────────────────

function BriefingHero({
  briefing,
  topPickTrade,
  onRegenerate,
  regenerating,
}: {
  briefing: BriefingRow;
  topPickTrade: TopPickTrade | null;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const regime = REGIME_META[briefing.regime];
  // Strip the leading `**WHAT:**` / `**SO WHAT:**` / `**WATCH:**` markers
  // from each paragraph — we render those as a chip ourselves, so the
  // markdown markers in the body text would render as literal asterisks.
  // Also handles minor variants (no colon, lowercase, "Watch" prefix).
  const stripPrefix = (p: string): string =>
    p
      .replace(
        /^\*{0,2}\s*(WHAT|SO[- ]?WHAT|WATCH)\s*[:\-—]?\s*\*{0,2}\s*/i,
        "",
      )
      .trim();
  const paragraphs = briefing.body
    .split(/\n\s*\n/)
    .map((p) => stripPrefix(p.trim()))
    .filter(Boolean);

  const tierColor =
    topPickTrade?.tier === "auto"
      ? ACCENT
      : topPickTrade?.tier === "review"
        ? "#7fa9d1"
        : TEXT_DIM;
  const topDirColor =
    briefing.top_pick?.direction === "long"
      ? POSITIVE
      : briefing.top_pick?.direction === "short"
        ? NEGATIVE
        : WARNING;

  return (
    <article
      className="relative flex flex-col py-8"
      style={{
        borderTop: `1px solid ${BORDER_QUIET}`,
        paddingLeft: "26px",
        paddingRight: "26px",
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          top: "22px",
          bottom: "22px",
          width: "2px",
          background: regime.color,
          opacity: 0.85,
        }}
      />

      {/* Kicker */}
      <div className="mb-4 flex items-baseline gap-x-3 flex-wrap">
        <span
          className="font-[var(--font-jetbrains-mono)]"
          style={{
            fontSize: "10px",
            fontWeight: 600,
            letterSpacing: "0.22em",
            color: ACCENT,
            textTransform: "uppercase",
          }}
        >
          Daily Briefing
        </span>
        <span style={{ color: TEXT_DIM, fontSize: "11px" }}>·</span>
        <span
          className="font-[var(--font-jetbrains-mono)]"
          style={{
            fontSize: "10px",
            fontWeight: 600,
            letterSpacing: "0.22em",
            color: regime.color,
            textTransform: "uppercase",
          }}
        >
          {regime.label}
        </span>
        <span
          className="font-[var(--font-inter)] tabular-nums ml-auto"
          style={{ fontSize: "12px", color: TEXT_MUTED }}
        >
          {briefing.date} UTC · generated {fmtRelative(briefing.generated_at)}
        </span>
      </div>

      {/* Headline — Fraunces */}
      <h2
        className="font-[var(--font-fraunces)]"
        style={{
          fontSize: "32px",
          fontWeight: 400,
          lineHeight: 1.18,
          letterSpacing: "-0.02em",
          color: TEXT_BRAND,
          marginBottom: "32px",
          maxWidth: "26ch",
        }}
      >
        {briefing.headline}
      </h2>

      {/* Two-column body — text on the left, trade sidebar on the right. */}
      <div
        className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
        style={{ gap: "56px", marginBottom: "32px" }}
      >
        {/* LEFT — 3-paragraph body */}
        <div className="flex flex-col gap-6">
          {paragraphs.map((p, i) => {
            const label = ["What", "So what", "Watch"][i] ?? `P${i + 1}`;
            return (
              <div key={i} className="flex flex-col gap-2">
                <span
                  className="font-[var(--font-jetbrains-mono)]"
                  style={{
                    fontSize: "9.5px",
                    fontWeight: 600,
                    letterSpacing: "0.22em",
                    color: TEXT_DIM,
                    textTransform: "uppercase",
                  }}
                >
                  {label}
                </span>
                <p
                  className="font-[var(--font-inter)]"
                  style={{
                    fontSize: "14px",
                    lineHeight: 1.7,
                    color: TEXT_MUTED,
                  }}
                >
                  {p}
                </p>
              </div>
            );
          })}
        </div>

        {/* RIGHT — top pick sidebar, fills the previously-empty space */}
        <div className="flex flex-col">
      {briefing.top_pick ? (
        <div
          className="relative flex flex-col py-5"
          style={{
            paddingLeft: "22px",
            background: "rgba(237, 228, 211, 0.02)",
            paddingRight: "20px",
            paddingTop: "20px",
            paddingBottom: "20px",
          }}
        >
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: 0,
              top: "20px",
              bottom: "20px",
              width: "2px",
              background: tierColor,
              opacity: 0.85,
            }}
          />

          <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
            <span
              className="font-[var(--font-jetbrains-mono)] uppercase"
              style={{
                fontSize: "10px",
                fontWeight: 600,
                letterSpacing: "0.22em",
                color: ACCENT,
              }}
            >
              If I had to take one trade today
            </span>
          </div>
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
            <span
              className="font-[var(--font-jetbrains-mono)]"
              style={{
                fontSize: "13px",
                fontWeight: 600,
                color: TEXT_BRAND,
                letterSpacing: "0.04em",
              }}
            >
              {briefing.top_pick.asset_symbol}
            </span>
            <span style={{ color: TEXT_DIM, fontSize: "11px" }}>·</span>
            <span
              className="font-[var(--font-jetbrains-mono)] uppercase"
              style={{
                fontSize: "10px",
                fontWeight: 600,
                letterSpacing: "0.22em",
                color: topDirColor,
              }}
            >
              {briefing.top_pick.direction}
            </span>
            {topPickTrade?.tier ? (
              <>
                <span style={{ color: TEXT_DIM, fontSize: "11px" }}>·</span>
                <span
                  className="font-[var(--font-jetbrains-mono)] uppercase"
                  style={{
                    fontSize: "10px",
                    letterSpacing: "0.22em",
                    color: tierColor,
                  }}
                >
                  {topPickTrade.tier}
                </span>
              </>
            ) : null}
            <span
              className="font-[var(--font-jetbrains-mono)] tabular-nums ml-auto"
              style={{
                fontSize: "10px",
                letterSpacing: "0.12em",
                color: TEXT_MUTED,
                textTransform: "uppercase",
              }}
            >
              {(briefing.top_pick.conviction * 100).toFixed(0)}% Conviction
            </span>
          </div>

          <p
            className="font-[var(--font-inter)]"
            style={{
              fontSize: "14px",
              lineHeight: 1.65,
              color: TEXT_BRAND,
              marginBottom: "20px",
              maxWidth: "70ch",
              fontWeight: 400,
            }}
          >
            {briefing.top_pick.thesis}
          </p>

          {/* Trade levels — entry / stop / target / size */}
          {topPickTrade ? (
            <div
              className="flex flex-wrap items-start"
              style={{
                columnGap: "32px",
                rowGap: "16px",
                paddingTop: "16px",
                borderTop: `1px solid ${BORDER_QUIET}`,
                marginBottom: "16px",
              }}
            >
              <BriefFigure
                label="Entry"
                value={
                  topPickTrade.entry_price != null
                    ? fmtPrice(topPickTrade.entry_price)
                    : "live"
                }
                sub={fmtSodexSymbol(topPickTrade.sodex_symbol)}
              />
              <BriefFigure
                label="Stop"
                value={fmtPrice(topPickTrade.stop_price)}
                sub={
                  topPickTrade.stop_pct != null
                    ? `−${topPickTrade.stop_pct.toFixed(1)}%`
                    : undefined
                }
                tone="negative"
              />
              <BriefFigure
                label="Target"
                value={fmtPrice(topPickTrade.target_price)}
                sub={
                  topPickTrade.target_pct != null
                    ? `+${topPickTrade.target_pct.toFixed(1)}%`
                    : undefined
                }
                tone="positive"
              />
              <BriefFigure
                label="Size"
                value={
                  topPickTrade.size_usd != null
                    ? `$${topPickTrade.size_usd.toLocaleString()}`
                    : "—"
                }
                sub={
                  topPickTrade.rr_ratio != null
                    ? `R:R ${topPickTrade.rr_ratio.toFixed(2)}`
                    : undefined
                }
              />
            </div>
          ) : (
            <div
              className="font-[var(--font-inter)]"
              style={{
                fontSize: "12px",
                color: TEXT_DIM,
                fontStyle: "italic",
                paddingTop: "16px",
                borderTop: `1px solid ${BORDER_QUIET}`,
                marginBottom: "16px",
              }}
            >
              Underlying signal expired since briefing was generated —
              no live levels to attach.
            </div>
          )}

          {/* Trade-quality line: subtype · horizon · relevance · source */}
          {topPickTrade ? (
            <div
              className="font-[var(--font-jetbrains-mono)] flex flex-wrap items-center"
              style={{
                fontSize: "10px",
                letterSpacing: "0.16em",
                color: TEXT_DIM,
                textTransform: "uppercase",
                columnGap: "18px",
                rowGap: "6px",
                marginBottom: "20px",
              }}
            >
              {topPickTrade.catalyst_subtype ? (
                <span>{topPickTrade.catalyst_subtype.replace(/_/g, " ")}</span>
              ) : null}
              {topPickTrade.expected_horizon ? (
                <span>Horizon {topPickTrade.expected_horizon}</span>
              ) : null}
              {topPickTrade.asset_relevance != null ? (
                <span
                  style={{
                    color:
                      topPickTrade.asset_relevance >= 0.95
                        ? POSITIVE
                        : topPickTrade.asset_relevance >= 0.75
                          ? "#7fa9d1"
                          : TEXT_DIM,
                  }}
                >
                  Relev {topPickTrade.asset_relevance.toFixed(2)}
                </span>
              ) : null}
              {topPickTrade.source_tier != null ? (
                <span>Source T{topPickTrade.source_tier}</span>
              ) : null}
            </div>
          ) : null}

          {/* Backtest panel — editorial sub-section */}
          {topPickTrade?.backtest ? (
            <div
              style={{
                paddingTop: "16px",
                borderTop: `1px solid ${BORDER_QUIET}`,
                marginBottom: "20px",
              }}
            >
              <div
                className="font-[var(--font-jetbrains-mono)] flex items-baseline justify-between"
                style={{
                  fontSize: "9.5px",
                  fontWeight: 600,
                  letterSpacing: "0.22em",
                  color: TEXT_DIM,
                  textTransform: "uppercase",
                  marginBottom: "14px",
                }}
              >
                <span>Backtest · same catalyst class</span>
                <span style={{ letterSpacing: "0.1em" }}>
                  n = {topPickTrade.backtest.sample_size} events
                </span>
              </div>
              <div
                className="flex flex-wrap items-start"
                style={{ columnGap: "32px", rowGap: "16px" }}
              >
                <BriefFigure
                  label="Hit rate (T+1d)"
                  value={
                    topPickTrade.backtest.hit_rate_1d_pct != null
                      ? `${topPickTrade.backtest.hit_rate_1d_pct.toFixed(0)}%`
                      : "—"
                  }
                  sub={
                    topPickTrade.backtest.expected_direction === "up"
                      ? "moves up"
                      : topPickTrade.backtest.expected_direction === "down"
                        ? "moves down"
                        : undefined
                  }
                  tone={
                    (topPickTrade.backtest.hit_rate_1d_pct ?? 0) >= 60
                      ? "positive"
                      : (topPickTrade.backtest.hit_rate_1d_pct ?? 0) < 50
                        ? "negative"
                        : "neutral"
                  }
                />
                <BriefFigure
                  label="Avg T+1d"
                  value={
                    topPickTrade.backtest.avg_impact_1d_pct != null
                      ? `${topPickTrade.backtest.avg_impact_1d_pct >= 0 ? "+" : ""}${topPickTrade.backtest.avg_impact_1d_pct.toFixed(2)}%`
                      : "—"
                  }
                  tone={
                    (topPickTrade.backtest.avg_impact_1d_pct ?? 0) > 0
                      ? "positive"
                      : (topPickTrade.backtest.avg_impact_1d_pct ?? 0) < 0
                        ? "negative"
                        : "neutral"
                  }
                />
                <BriefFigure
                  label="Avg T+3d"
                  value={
                    topPickTrade.backtest.avg_impact_3d_pct != null
                      ? `${topPickTrade.backtest.avg_impact_3d_pct >= 0 ? "+" : ""}${topPickTrade.backtest.avg_impact_3d_pct.toFixed(2)}%`
                      : "—"
                  }
                  tone={
                    (topPickTrade.backtest.avg_impact_3d_pct ?? 0) > 0
                      ? "positive"
                      : (topPickTrade.backtest.avg_impact_3d_pct ?? 0) < 0
                        ? "negative"
                        : "neutral"
                  }
                />
                <BriefFigure
                  label="Bucket"
                  value={`${topPickTrade.backtest.event_type}/${topPickTrade.backtest.sentiment.charAt(0)}`}
                  sub="event · sentiment"
                />
              </div>
            </div>
          ) : null}

          {/* Invalidation thesis */}
          {topPickTrade ? (
            <div
              style={{
                paddingTop: "16px",
                borderTop: `1px solid ${BORDER_QUIET}`,
              }}
            >
              <div
                className="font-[var(--font-jetbrains-mono)]"
                style={{
                  fontSize: "9.5px",
                  fontWeight: 600,
                  letterSpacing: "0.22em",
                  color: TEXT_DIM,
                  textTransform: "uppercase",
                  marginBottom: "10px",
                }}
              >
                What would invalidate this thesis
              </div>
              <ul
                className="font-[var(--font-inter)] flex flex-col"
                style={{
                  fontSize: "13px",
                  lineHeight: 1.65,
                  color: TEXT_MUTED,
                  gap: "4px",
                  maxWidth: "70ch",
                }}
              >
                {topPickTrade.stop_price != null ? (
                  <li>
                    Price reaches{" "}
                    <span
                      className="tabular-nums"
                      style={{ color: NEGATIVE }}
                    >
                      {fmtPrice(topPickTrade.stop_price)}
                    </span>
                    {topPickTrade.stop_pct != null
                      ? ` (−${topPickTrade.stop_pct.toFixed(1)}% from entry)`
                      : ""}
                    {" — stop trigger, exit the trade."}
                  </li>
                ) : null}
                {topPickTrade.expires_at != null ? (
                  <li>
                    {topPickTrade.expected_horizon ?? "Horizon"} elapses
                    without follow-through (
                    <span className="tabular-nums">
                      {fmtUntil(topPickTrade.expires_at)}
                    </span>
                    {") — catalyst window closes, thesis stale."}
                  </li>
                ) : null}
                {(topPickTrade.source_tier ?? 1) > 1 ? (
                  <li>
                    No tier-1 outlet corroborates the source within 4–8h —
                    auto-dismisses as uncorroborated.
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
        </div>
      </div>

      {/* Watchlist — hairline-divided rows, no boxes */}
      {briefing.watchlist.length > 0 ? (
        <div style={{ marginBottom: "28px" }}>
          <div
            className="font-[var(--font-jetbrains-mono)] uppercase"
            style={{
              fontSize: "9.5px",
              fontWeight: 600,
              letterSpacing: "0.22em",
              color: TEXT_DIM,
              marginBottom: "12px",
            }}
          >
            Also watching
          </div>
          <ul className="flex flex-col">
            {briefing.watchlist.map((w, i) => (
              <li
                key={i}
                className="flex items-baseline gap-3"
                style={{
                  borderTop: `1px solid ${BORDER_QUIET}`,
                  padding: "10px 0",
                }}
              >
                <span
                  className="font-[var(--font-jetbrains-mono)]"
                  style={{
                    fontSize: "12px",
                    fontWeight: 600,
                    color: TEXT_BRAND,
                    letterSpacing: "0.04em",
                    minWidth: "60px",
                  }}
                >
                  {w.symbol}
                </span>
                <span
                  className="font-[var(--font-inter)]"
                  style={{
                    fontSize: "13px",
                    color: TEXT_MUTED,
                    lineHeight: 1.5,
                  }}
                >
                  {w.note}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Inputs transparency */}
      <details
        className="group"
        style={{
          borderTop: `1px solid ${BORDER_QUIET}`,
          paddingTop: "14px",
          marginBottom: "16px",
        }}
      >
        <summary
          className="cursor-pointer select-none font-[var(--font-jetbrains-mono)] uppercase"
          style={{
            fontSize: "9.5px",
            fontWeight: 600,
            letterSpacing: "0.22em",
            color: TEXT_DIM,
            listStyle: "none",
          }}
        >
          Inputs the briefing was built on
          <span
            className="group-open:hidden font-[var(--font-inter)] normal-case"
            style={{
              fontSize: "11px",
              color: TEXT_DIM,
              letterSpacing: "0.01em",
              marginLeft: "10px",
              textTransform: "none",
              fontWeight: 400,
            }}
          >
            (click to expand)
          </span>
        </summary>
        <InputsSummary inputs={briefing.inputs_summary} />
      </details>

      {/* Footer — model / cost / regenerate */}
      <div
        className="flex flex-wrap items-center justify-between gap-3"
        style={{
          borderTop: `1px solid ${BORDER_QUIET}`,
          paddingTop: "14px",
        }}
      >
        <span
          className="font-[var(--font-jetbrains-mono)] tabular-nums"
          style={{
            fontSize: "10px",
            letterSpacing: "0.06em",
            color: TEXT_DIM,
            textTransform: "uppercase",
          }}
        >
          {briefing.model} · {briefing.prompt_version} ·{" "}
          {briefing.tokens_input.toLocaleString()}/
          {briefing.tokens_output.toLocaleString()}/
          {briefing.tokens_cached.toLocaleString()} tokens
        </span>
        <button
          onClick={onRegenerate}
          disabled={regenerating}
          className="font-[var(--font-jetbrains-mono)] transition-all"
          style={{
            fontSize: "10px",
            fontWeight: 500,
            letterSpacing: "0.18em",
            padding: "6px 14px",
            border: `1px solid ${BORDER_QUIET}`,
            color: TEXT_MUTED,
            background: "transparent",
            cursor: regenerating ? "wait" : "pointer",
            textTransform: "uppercase",
            borderRadius: "2px",
          }}
        >
          {regenerating ? "Regenerating…" : "↻ Regenerate"}
        </button>
      </div>
    </article>
  );
}

function InputsSummary({ inputs }: { inputs: BriefingInputsSummary }) {
  const rows: Array<{ label: string; body: string; sub?: string }> = [
    {
      label: "Signal pipeline",
      body: `${inputs.pending_signals} pending signals · ${inputs.classifications_24h} classifications in last 24h`,
      sub:
        inputs.top_event_types.length > 0
          ? `top types: ${inputs.top_event_types.map((t) => `${t.event_type}(${t.n})`).join(", ")}`
          : undefined,
    },
    {
      label: "AlphaIndex top positions",
      body:
        inputs.alphaindex_top_positions.length === 0
          ? "(no positions)"
          : inputs.alphaindex_top_positions
              .map((p) => `${p.symbol} ${p.weight_pct.toFixed(1)}%`)
              .join(" · "),
    },
    {
      label: "Sector leaders (24h)",
      body: inputs.sector_top
        .map(
          (s) =>
            `${s.name} ${s.change_24h_pct >= 0 ? "+" : ""}${s.change_24h_pct.toFixed(2)}%`,
        )
        .join(" · "),
    },
    {
      label: "Sector laggards (24h)",
      body: inputs.sector_bottom
        .map((s) => `${s.name} ${s.change_24h_pct.toFixed(2)}%`)
        .join(" · "),
    },
    {
      label: "ETF flows (24h, net)",
      body:
        inputs.etf_net_flow_24h_usd == null
          ? "(no recent data)"
          : fmtUsdCompact(inputs.etf_net_flow_24h_usd),
    },
    {
      label: "Track record signal",
      body: inputs.best_event_type_hit_rate
        ? `${inputs.best_event_type_hit_rate.event_type}: ${
            inputs.best_event_type_hit_rate.hit_rate_3d != null
              ? (inputs.best_event_type_hit_rate.hit_rate_3d * 100).toFixed(
                  0,
                ) + "%"
              : "—"
          } hit rate (n=${inputs.best_event_type_hit_rate.n})`
        : "(insufficient calibration data yet)",
    },
    {
      label: "Corporate BTC accumulation (30d)",
      body:
        inputs.treasury_summary &&
        inputs.treasury_summary.acquiring_companies > 0
          ? `${inputs.treasury_summary.acquiring_companies} treasuries acquired ` +
            `${inputs.treasury_summary.net_btc_acquired.toLocaleString()} BTC` +
            (inputs.treasury_summary.total_acq_cost_usd != null
              ? ` (${fmtUsdCompact(inputs.treasury_summary.total_acq_cost_usd)} disclosed)`
              : "") +
            ` · total held: ${inputs.treasury_summary.total_btc_held_latest.toLocaleString()} BTC`
          : "(no recent purchases on file)",
    },
  ];
  return (
    <div
      className="grid grid-cols-1 md:grid-cols-2"
      style={{ marginTop: "16px", columnGap: "32px", rowGap: "18px" }}
    >
      {rows.map((r, i) => (
        <div key={i} className="flex flex-col" style={{ gap: "4px" }}>
          <span
            className="font-[var(--font-jetbrains-mono)] uppercase"
            style={{
              fontSize: "9px",
              fontWeight: 500,
              letterSpacing: "0.18em",
              color: TEXT_DIM,
            }}
          >
            {r.label}
          </span>
          <span
            className="font-[var(--font-inter)]"
            style={{
              fontSize: "12.5px",
              color: TEXT_MUTED,
              lineHeight: 1.55,
            }}
          >
            {r.body}
          </span>
          {r.sub ? (
            <span
              className="font-[var(--font-jetbrains-mono)]"
              style={{
                fontSize: "10px",
                letterSpacing: "0.06em",
                color: TEXT_DIM,
              }}
            >
              {r.sub}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Archive row — editorial briefing-log entry, not a card.
// ─────────────────────────────────────────────────────────────────────────

function ArchiveRow({ briefing }: { briefing: BriefingRow }) {
  const regime = REGIME_META[briefing.regime];
  return (
    <article
      className="relative flex flex-col py-5"
      style={{
        borderTop: `1px solid ${BORDER_QUIET}`,
        paddingLeft: "22px",
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          top: "20px",
          bottom: "20px",
          width: "2px",
          background: regime.color,
          opacity: 0.75,
        }}
      />
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
        <span
          className="font-[var(--font-jetbrains-mono)] uppercase"
          style={{
            fontSize: "10px",
            fontWeight: 600,
            letterSpacing: "0.22em",
            color: regime.color,
          }}
        >
          {regime.label}
        </span>
        <span style={{ color: TEXT_DIM, fontSize: "11px" }}>·</span>
        <span
          className="font-[var(--font-jetbrains-mono)] tabular-nums uppercase"
          style={{
            fontSize: "10px",
            letterSpacing: "0.18em",
            color: TEXT_MUTED,
          }}
        >
          {briefing.date}
        </span>
        <span
          className="font-[var(--font-inter)] tabular-nums ml-auto"
          style={{ fontSize: "11px", color: TEXT_DIM }}
        >
          {fmtRelative(briefing.generated_at)}
        </span>
      </div>
      <p
        className="font-[var(--font-fraunces)]"
        style={{
          fontSize: "16px",
          fontWeight: 400,
          lineHeight: 1.3,
          letterSpacing: "-0.01em",
          color: TEXT_BRAND,
          maxWidth: "70ch",
        }}
      >
        {briefing.headline}
      </p>
      {briefing.top_pick ? (
        <p
          className="font-[var(--font-inter)]"
          style={{
            fontSize: "12.5px",
            lineHeight: 1.6,
            color: TEXT_MUTED,
            marginTop: "8px",
            maxWidth: "70ch",
          }}
        >
          <span
            className="font-[var(--font-jetbrains-mono)]"
            style={{ color: TEXT_BRAND, fontWeight: 600, fontSize: "11px" }}
          >
            {briefing.top_pick.asset_symbol}
          </span>{" "}
          <span
            className="font-[var(--font-jetbrains-mono)] uppercase"
            style={{
              fontSize: "9.5px",
              letterSpacing: "0.18em",
              color:
                briefing.top_pick.direction === "long"
                  ? POSITIVE
                  : briefing.top_pick.direction === "short"
                    ? NEGATIVE
                    : WARNING,
            }}
          >
            {briefing.top_pick.direction}
          </span>{" "}
          — {briefing.top_pick.thesis.slice(0, 130)}
          {briefing.top_pick.thesis.length > 130 ? "…" : ""}
        </p>
      ) : null}
    </article>
  );
}

/**
 * One slot in the top-pick trade-levels grid. Fraunces value, mono small-caps label.
 */
function BriefFigure({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "positive" | "negative" | "neutral";
}) {
  const color =
    tone === "positive"
      ? POSITIVE
      : tone === "negative"
        ? NEGATIVE
        : TEXT_BRAND;
  return (
    <div className="flex flex-col" style={{ minWidth: "72px" }}>
      <span
        className="font-[var(--font-fraunces)] tabular-nums"
        style={{
          fontSize: "20px",
          fontWeight: 400,
          color,
          letterSpacing: "-0.012em",
          lineHeight: 1.1,
        }}
      >
        {value}
      </span>
      <span
        className="font-[var(--font-jetbrains-mono)] uppercase"
        style={{
          fontSize: "8.5px",
          fontWeight: 500,
          letterSpacing: "0.18em",
          color: TEXT_DIM,
          marginTop: "5px",
        }}
      >
        {label}
      </span>
      {sub ? (
        <span
          className="font-[var(--font-jetbrains-mono)] tabular-nums"
          style={{
            fontSize: "10px",
            color: TEXT_DIM,
            marginTop: "3px",
          }}
        >
          {sub}
        </span>
      ) : null}
    </div>
  );
}
