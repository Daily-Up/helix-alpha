"use client";

/**
 * Hero anchor — a representative signal card rendered in the landing
 * page hero: asset + direction, the catalyst, a confidence read, and the
 * risk bracket, so the abstract "verifiable signals" claim becomes
 * concrete in 3 seconds. Plain-language — no internal scoring/invariant
 * codes (this is a marketing surface, not the ops view).
 *
 * Static content. Clicking the card deep-links to `/signals` (the live
 * feed) for any visitor curious enough to inspect a real one.
 */

import Link from "next/link";

const TEXT = "#ede4d3";
const TEXT_MUTED = "#8a857a";
const ACCENT = "#d97757";

export function HeroSignalCard() {
  return (
    <Link
      href="/signals"
      className="group block w-full transition-all duration-200 hover:-translate-y-[3px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#d97757]"
      style={{
        background: "transparent",
        border: `1px solid ${TEXT}33`,
      }}
    >
      <div className="flex flex-col p-5">
        {/* Header — tier + asset */}
        <div className="flex items-center justify-between" data-card-part>
          <div className="flex items-center gap-2">
            <span
              data-card-badge
              className="font-[var(--font-jetbrains-mono)] uppercase"
              style={{
                fontSize: "10px",
                color: ACCENT,
                border: `1px solid ${ACCENT}80`,
                padding: "2px 6px",
                letterSpacing: "0.08em",
              }}
            >
              REVIEW
            </span>
            <span
              className="font-[var(--font-jetbrains-mono)] uppercase"
              style={{ fontSize: "10px", color: TEXT_MUTED, letterSpacing: "0.06em" }}
            >
              ETF INFLOW
            </span>
          </div>
          <span
            className="font-[var(--font-jetbrains-mono)] flex items-center gap-2"
            style={{ fontSize: "11px", color: TEXT_MUTED }}
          >
            17m ago
          </span>
        </div>

        {/* Asset + direction */}
        <div className="mt-5 flex items-baseline gap-3" data-card-part>
          <span
            className="font-[var(--font-fraunces)] font-medium"
            style={{ fontSize: "32px", color: TEXT, letterSpacing: "-0.01em" }}
          >
            BTC
          </span>
          <span
            className="font-[var(--font-jetbrains-mono)] uppercase"
            style={{ fontSize: "12px", color: ACCENT, letterSpacing: "0.08em" }}
          >
            LONG · 48H
          </span>
        </div>

        {/* Headline */}
        <p
          data-card-part
          className="mt-3 font-[var(--font-inter)]"
          style={{ fontSize: "15px", color: TEXT, lineHeight: 1.45 }}
        >
          BlackRock IBIT records $328M net inflow on the day, the largest
          single-day intake since the post-halving cycle.
        </p>

        {/* Confidence */}
        <div
          data-card-part
          className="mt-5 border-t pt-4"
          style={{ borderColor: `${TEXT}20` }}
        >
          <div
            className="flex items-center justify-between font-[var(--font-jetbrains-mono)] uppercase"
            style={{ fontSize: "10px", color: TEXT_MUTED, letterSpacing: "0.08em" }}
          >
            <span>Confidence</span>
            <span className="tabular-nums" style={{ color: TEXT }}>
              <span data-card-counter="68">68</span>%
            </span>
          </div>
          <div
            className="mt-2 h-1 w-full overflow-hidden rounded-full"
            style={{ background: `${TEXT}18` }}
          >
            <div
              style={{ width: "68%", height: "100%", background: ACCENT, borderRadius: 999 }}
            />
          </div>
        </div>

        {/* Risk params */}
        <div
          data-card-part
          className="mt-4 border-t pt-4"
          style={{ borderColor: `${TEXT}20` }}
        >
          <div className="grid grid-cols-3 gap-3">
            <Param label="TARGET" value="+4.0%" />
            <Param label="STOP" value="−2.5%" />
            <Param label="HORIZON" value="48h" />
          </div>
        </div>

        {/* Footer — human, not internal invariant IDs */}
        <div
          className="mt-5 border-t pt-3 font-[var(--font-jetbrains-mono)] uppercase"
          style={{
            borderColor: `${TEXT}20`,
            fontSize: "10px",
            color: TEXT_MUTED,
            letterSpacing: "0.06em",
          }}
        >
          Full reasoning chain · outcome-tracked
        </div>
      </div>
    </Link>
  );
}

function Param({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        className="font-[var(--font-jetbrains-mono)] uppercase"
        style={{
          fontSize: "10px",
          color: TEXT_MUTED,
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </div>
      <div
        className="mt-1 font-[var(--font-inter)] font-medium tabular-nums"
        style={{ fontSize: "15px", color: TEXT }}
      >
        {value}
      </div>
    </div>
  );
}
