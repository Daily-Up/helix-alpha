"use client";

import Link from "next/link";

const TEXT = "#f0e8db";
const TEXT_MUTED = "#9a8e7d";
const ACCENT = "#c87a4a";
const ACCENT_GLOW = "#d4a574";

export function WarmHeroSignalCard() {
  return (
    <Link
      href="/signals"
      className="group block w-full transition-all duration-300 hover:shadow-[0_8px_40px_rgba(200,122,74,0.08)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#c87a4a]"
      style={{
        background: "#1a1714",
        border: `1px solid ${TEXT}15`,
        borderRadius: "2px",
      }}
    >
      <div className="flex flex-col p-5">
        {/* Header — tier + asset */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
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
            className="font-[var(--font-jetbrains-mono)]"
            style={{ fontSize: "11px", color: TEXT_MUTED }}
          >
            17m ago
          </span>
        </div>

        {/* Asset + direction */}
        <div className="mt-5 flex items-baseline gap-3">
          <span
            className="font-[var(--font-fraunces)] font-medium"
            style={{ fontSize: "32px", color: TEXT, letterSpacing: "-0.01em" }}
          >
            BTC
          </span>
          <span
            className="font-[var(--font-jetbrains-mono)] uppercase"
            style={{ fontSize: "12px", color: ACCENT_GLOW, letterSpacing: "0.08em" }}
          >
            LONG · 48H
          </span>
        </div>

        {/* Headline */}
        <p
          className="mt-3 font-[var(--font-inter)]"
          style={{ fontSize: "15px", color: TEXT, lineHeight: 1.45 }}
        >
          BlackRock IBIT records $328M net inflow on the day, the largest
          single-day intake since the post-halving cycle.
        </p>

        {/* Conviction breakdown */}
        <div
          className="mt-5 border-t pt-4"
          style={{ borderColor: `${TEXT}12` }}
        >
          <div
            className="font-[var(--font-jetbrains-mono)] uppercase"
            style={{
              fontSize: "10px",
              color: TEXT_MUTED,
              letterSpacing: "0.08em",
            }}
          >
            CONVICTION 0.68 · BREAKDOWN
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <BreakdownCell label="RELEV" value="0.92" />
            <BreakdownCell label="CORR" value="0.74" />
            <BreakdownCell label="SRC" value="T1" />
          </div>
        </div>

        {/* Risk params */}
        <div
          className="mt-4 border-t pt-4"
          style={{ borderColor: `${TEXT}12` }}
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
            borderColor: `${TEXT}12`,
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

function BreakdownCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        className="font-[var(--font-jetbrains-mono)] uppercase"
        style={{ fontSize: "10px", color: TEXT_MUTED, letterSpacing: "0.08em" }}
      >
        {label}
      </div>
      <div
        className="mt-1 font-[var(--font-jetbrains-mono)] tabular-nums"
        style={{ fontSize: "16px", color: TEXT }}
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
        style={{ fontSize: "10px", color: TEXT_MUTED, letterSpacing: "0.08em" }}
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
