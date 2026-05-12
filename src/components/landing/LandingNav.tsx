"use client";

/**
 * Helix landing — top nav.
 *
 * Transparent over the hero, transitions to solid #0b0b0e (with thin
 * 1px border at #ede4d3 / 10%) once the user scrolls past the hero
 * (~85vh). The transition is a single 200ms color/border interp —
 * no parallax, no animated decoration.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

const TEXT = "#ede4d3";
const TEXT_MUTED = "#8a857a";
const ACCENT = "#d97757";
const BG = "#0b0b0e";
const SCROLL_THRESHOLD_PX = 80;

const NAV_LINKS = [
  { href: "#why-audit", label: "Why audit" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#frameworks", label: "Frameworks" },
  { href: "#calibration", label: "Calibration" },
];

export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > SCROLL_THRESHOLD_PX);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className="fixed inset-x-0 top-0 z-50 transition-[background-color,border-color] duration-200"
      style={{
        background: scrolled ? BG : "transparent",
        borderBottom: `1px solid ${scrolled ? `${TEXT}1a` : "transparent"}`,
      }}
    >
      <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-6 px-6 py-4 md:px-12">
        {/* Wordmark + positioning */}
        <Link href="/" className="flex flex-col leading-tight">
          <span
            className="font-[var(--font-fraunces)] font-medium"
            style={{ fontSize: "22px", color: TEXT }}
          >
            Helix
          </span>
          <span
            className="font-[var(--font-jetbrains-mono)]"
            style={{ fontSize: "11px", color: TEXT_MUTED, letterSpacing: "0.04em" }}
          >
            Event-driven alpha
          </span>
        </Link>

        {/* Center-right nav links */}
        <nav className="hidden items-center gap-7 md:flex">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="font-[var(--font-inter)] transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d97757]"
              style={{ color: TEXT_MUTED, fontSize: "14px" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = TEXT)}
              onMouseLeave={(e) => (e.currentTarget.style.color = TEXT_MUTED)}
            >
              {l.label}
            </a>
          ))}
        </nav>

        {/* Right — Launch dashboard */}
        <Link
          href="/app"
          className="group inline-flex items-center gap-1 font-[var(--font-inter)] font-medium transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d97757]"
          style={{
            fontSize: "14px",
            color: ACCENT,
            border: `1px solid ${ACCENT}`,
            padding: "8px 16px",
            borderRadius: "4px",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = ACCENT;
            e.currentTarget.style.color = BG;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = ACCENT;
          }}
        >
          Launch dashboard <span aria-hidden>→</span>
        </Link>
      </div>
    </header>
  );
}
