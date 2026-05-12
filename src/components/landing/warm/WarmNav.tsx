"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const TEXT = "#f0e8db";
const TEXT_MUTED = "#9a8e7d";
const ACCENT = "#c87a4a";
const BG = "#12100e";
const SCROLL_THRESHOLD_PX = 80;

const NAV_LINKS = [
  { href: "#why-audit", label: "Why audit" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#frameworks", label: "Frameworks" },
  { href: "#calibration", label: "Calibration" },
];

export function WarmNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > SCROLL_THRESHOLD_PX);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className="fixed inset-x-0 top-0 z-50 transition-all duration-300"
      style={{
        background: scrolled ? BG : "transparent",
        borderBottom: `1px solid ${scrolled ? `${TEXT}10` : "transparent"}`,
        backdropFilter: scrolled ? "blur(12px)" : "none",
      }}
    >
      <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-6 px-6 py-4 md:px-12">
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

        <nav className="hidden items-center gap-7 md:flex">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="font-[var(--font-inter)] transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c87a4a]"
              style={{ color: TEXT_MUTED, fontSize: "14px" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = TEXT)}
              onMouseLeave={(e) => (e.currentTarget.style.color = TEXT_MUTED)}
            >
              {l.label}
            </a>
          ))}
        </nav>

        <Link
          href="/app"
          className="group inline-flex items-center gap-1 font-[var(--font-inter)] font-medium transition-all duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c87a4a]"
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
            e.currentTarget.style.boxShadow = `0 4px 20px rgba(200,122,74,0.3)`;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = ACCENT;
            e.currentTarget.style.boxShadow = "none";
          }}
        >
          Launch dashboard <span aria-hidden>→</span>
        </Link>
      </div>
    </header>
  );
}
