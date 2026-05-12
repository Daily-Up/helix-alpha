"use client";

/**
 * Hero anchor — a representative signal card rendered in the landing
 * page hero. Mirrors the structure of the live signal feed cards
 * (RELEV / CORR / SRC tier badges, conviction breakdown, asset
 * relevance) so the abstract "audited signals" claim becomes concrete
 * in 3 seconds.
 *
 * Static content — this is a marketing surface, not a live data tap.
 * Clicking the card deep-links to `/signals` (the live feed) for any
 * visitor curious enough to inspect a real one.
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
              ETF FLOW · LARGE_CAP_CRYPTO
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

        {/* Conviction breakdown */}
        <div
          data-card-part
          className="mt-5 border-t pt-4"
          style={{ borderColor: `${TEXT}20` }}
        >
          <div
            className="font-[var(--font-jetbrains-mono)] uppercase"
            style={{
              fontSize: "10px",
              color: TEXT_MUTED,
              letterSpacing: "0.08em",
            }}
          >
            CONVICTION <span data-card-counter="0.68" className="tabular-nums">0.68</span> · BREAKDOWN
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <BreakdownCell label="RELEV" value="0.92" counter />
            <BreakdownCell label="CORR" value="0.74" counter />
            <BreakdownCell label="SRC" value="T1" />
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

        {/* Footer — invariant trail */}
        <div
          className="mt-5 border-t pt-3 font-[var(--font-jetbrains-mono)]"
          style={{
            borderColor: `${TEXT}20`,
            fontSize: "10px",
            color: TEXT_MUTED,
            letterSpacing: "0.04em",
          }}
        >
          I-05 · I-09 · I-15 · I-21 · I-30
        </div>
      </div>
    </Link>
  );
}

function BreakdownCell({
  label,
  value,
  counter,
}: {
  label: string;
  value: string;
  counter?: boolean;
}) {
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
        className="mt-1 font-[var(--font-jetbrains-mono)] tabular-nums"
        style={{ fontSize: "16px", color: TEXT }}
        {...(counter ? { "data-card-counter": value } : {})}
      >
        {value}
      </div>
    </div>
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
