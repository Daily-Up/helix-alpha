"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

export function LandingMotion() {
  const ctxRef = useRef<gsap.Context | null>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.matchMedia().add(
        {
          motion: "(prefers-reduced-motion: no-preference)",
          reduced: "(prefers-reduced-motion: reduce)",
        },
        (context) => {
          const { motion } = context.conditions!;

          initHero(motion!);
          initStats(motion!);
          initWhyAudit(motion!);
          initHowItWorks(motion!);
          initScreenshots(motion!);
          initFrameworks(motion!);
          initClosing(motion!);
        }
      );
    });

    ctxRef.current = ctx;
    return () => ctx.revert();
  }, []);

  return null;
}

// ─── Hero ────────────────────────────────────────────────────────────────

function initHero(motion: boolean) {
  // The hero MUST always be visible. A prior bug left it stranded at
  // opacity:0 whenever this timeline didn't run to completion (it can
  // stall or the gsap.context can revert). So we NEVER animate opacity
  // on the hero: (1) reveal everything up front — an inline opacity:1
  // overrides any Tailwind opacity-0 class — and (2) the intro animates
  // POSITION only. If the timeline freezes or reverts, content stays put
  // and visible.
  const HERO = [
    "[data-hero='eyebrow']",
    "[data-hero='line1']",
    "[data-hero='line2']",
    "[data-hero='subhead']",
    "[data-hero='ctas']",
    "[data-hero='card']",
    "[data-hero='period']",
  ];
  gsap.set(HERO, { opacity: 1 });
  gsap.set("[data-hero='line2'] .hero-char", { opacity: 1 });
  gsap.set("[data-card-part]", { opacity: 1 });
  const period = document.querySelector("[data-hero='period']");
  if (period) gsap.set(period, { opacity: 1, scale: 1 });

  // Reduced-motion (and no-JS) simply keep the static, visible hero.
  if (!motion) return;

  const tl = gsap.timeline({ defaults: { ease: "power2.out" } });
  tl.from("[data-hero='eyebrow']", { y: 6, duration: 0.4 });
  tl.from("[data-hero='line1']", { y: 12, duration: 0.6 }, "+=0.05");
  const line2Chars = document.querySelectorAll("[data-hero='line2'] .hero-char");
  if (line2Chars.length) {
    tl.from(line2Chars, { y: 12, duration: 0.5, stagger: 0.03 }, "-=0.35");
  }
  tl.from("[data-hero='subhead']", { y: 10, duration: 0.45 }, "-=0.2");
  tl.from("[data-hero='ctas']", { y: 10, duration: 0.4 }, "-=0.2");
  tl.from("[data-hero='card']", { y: 14, duration: 0.6 }, 0.3);
  const cardParts = document.querySelectorAll("[data-card-part]");
  if (cardParts.length) {
    tl.from(cardParts, { y: 6, duration: 0.4, stagger: 0.08 }, "-=0.3");
  }

  // Conviction counters in the card (visual flourish only — never hides).
  document.querySelectorAll<HTMLElement>("[data-card-counter]").forEach((el) => {
    const target = parseFloat(el.dataset.cardCounter!);
    if (Number.isNaN(target)) return;
    const obj = { val: 0 };
    tl.to(obj, {
      val: target,
      duration: 0.8,
      ease: "power2.out",
      onUpdate: () => {
        el.textContent = target % 1 === 0
          ? Math.round(obj.val).toString()
          : obj.val.toFixed(2);
      },
    }, "-=0.6");
  });
}

// ─── Stats ───────────────────────────────────────────────────────────────

function initStats(motion: boolean) {
  const section = document.querySelector("[data-section='stats']");
  if (!section) return;

  const counters = section.querySelectorAll<HTMLElement>("[data-counter]");
  const labels = section.querySelectorAll<HTMLElement>("[data-stat-label]");

  ScrollTrigger.create({
    trigger: section,
    start: "top 70%",
    once: true,
    onEnter: () => {
      if (motion) {
        counters.forEach((el) => {
          const target = parseInt(el.dataset.counter!, 10);
          const suffix = el.dataset.suffix || "";
          const obj = { val: 0 };
          const isElastic = target === 2;

          const duration = target > 100 ? 1.4 : target > 10 ? 1.2 : isElastic ? 1.0 : 1.1;
          const ease = isElastic ? "elastic.out(1, 0.5)" : "power2.out";

          gsap.to(obj, {
            val: target,
            duration,
            ease,
            onUpdate: () => {
              el.textContent = Math.round(obj.val).toString() + suffix;
            },
          });
        });

        gsap.fromTo(labels,
          { opacity: 0 },
          { opacity: 1, duration: 0.3, delay: 0.4 }
        );
      } else {
        counters.forEach((el) => {
          el.textContent = el.dataset.counter! + (el.dataset.suffix || "");
        });
        gsap.set(labels, { opacity: 1 });
      }
    },
  });
}

// ─── Why audit ───────────────────────────────────────────────────────────

function initWhyAudit(motion: boolean) {
  const section = document.querySelector("#why-audit");
  if (!section) return;

  const header = section.querySelector("[data-reveal='header']");
  const cards = section.querySelectorAll("[data-reveal='content']");
  const bars = section.querySelectorAll(".landing-audit-card-bar");

  ScrollTrigger.create({
    trigger: section,
    start: "top 80%",
    once: true,
    onEnter: () => {
      if (motion) {
        if (header) {
          gsap.fromTo(header,
            { opacity: 0, y: 8 },
            { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }
          );
        }
        gsap.fromTo(cards,
          { opacity: 0, y: 8 },
          { opacity: 1, y: 0, duration: 0.5, stagger: 0.15, delay: 0.15, ease: "power2.out" }
        );
        gsap.fromTo(bars,
          { width: 0 },
          { width: 32, duration: 0.3, stagger: 0.15, delay: 0.65, ease: "power2.out" }
        );
      } else {
        gsap.set(header, { opacity: 1 });
        gsap.set(cards, { opacity: 1 });
      }
    },
  });
}

// ─── How it works ────────────────────────────────────────────────────────

function initHowItWorks(motion: boolean) {
  const section = document.querySelector("#how-it-works");
  if (!section) return;

  const header = section.querySelector("[data-reveal='header']");
  const stages = section.querySelectorAll("[data-reveal='content']");
  const dots = section.querySelectorAll("[data-stage-dot]");
  const timelineFill = section.querySelector("[data-timeline-fill]") as HTMLElement;

  // Header reveal
  ScrollTrigger.create({
    trigger: section,
    start: "top 80%",
    once: true,
    onEnter: () => {
      if (motion) {
        gsap.fromTo(header,
          { opacity: 0, y: 8 },
          { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }
        );
      } else {
        gsap.set(header, { opacity: 1 });
      }
    },
  });

  // Timeline fill on scroll
  if (timelineFill && motion) {
    gsap.set(timelineFill, { scaleY: 0, transformOrigin: "top" });
    ScrollTrigger.create({
      trigger: section.querySelector("ol"),
      start: "top 70%",
      end: "bottom 40%",
      scrub: 0.5,
      onUpdate: (self) => {
        gsap.set(timelineFill, { scaleY: self.progress });
      },
    });
  }

  // Each stage
  stages.forEach((stage, i) => {
    ScrollTrigger.create({
      trigger: stage,
      start: "top 85%",
      once: true,
      onEnter: () => {
        if (motion) {
          gsap.fromTo(stage,
            { opacity: 0, y: 8 },
            { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }
          );
          if (dots[i]) {
            gsap.fromTo(dots[i],
              { scale: 0 },
              { scale: 1, duration: 0.3, ease: "elastic.out(1, 0.5)", delay: 0.1 }
            );
          }
        } else {
          gsap.set(stage, { opacity: 1 });
          if (dots[i]) gsap.set(dots[i], { scale: 1 });
        }
      },
    });
  });
}

// ─── Screenshots ─────────────────────────────────────────────────────────

function initScreenshots(motion: boolean) {
  const section = document.querySelector("#frameworks");
  if (!section) return;

  const header = section.querySelector("[data-reveal='header']");
  ScrollTrigger.create({
    trigger: section,
    start: "top 80%",
    once: true,
    onEnter: () => {
      if (motion) {
        gsap.fromTo(header,
          { opacity: 0, y: 8 },
          { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }
        );
      } else {
        gsap.set(header, { opacity: 1 });
      }
    },
  });

  const shots = document.querySelectorAll("[data-reveal='screenshot']");
  shots.forEach((shot) => {
    const caption = shot.querySelector("figcaption");
    ScrollTrigger.create({
      trigger: shot,
      start: "top 80%",
      once: true,
      onEnter: () => {
        if (motion) {
          gsap.fromTo(shot,
            { opacity: 0, scale: 0.96 },
            { opacity: 1, scale: 1, duration: 0.6, ease: "power2.out" }
          );
          if (caption) {
            gsap.fromTo(caption,
              { opacity: 0 },
              { opacity: 1, duration: 0.4, delay: 0.3, ease: "power1.out" }
            );
          }
        } else {
          gsap.set(shot, { opacity: 1, scale: 1 });
        }
      },
    });
  });
}

// ─── Frameworks table ────────────────────────────────────────────────────

function initFrameworks(motion: boolean) {
  const section = document.querySelector("#calibration");
  if (!section) return;

  const header = section.querySelector("[data-reveal='header']");
  const content = section.querySelectorAll("[data-reveal='content']");
  const rows = section.querySelectorAll("[data-table-row]");
  const v21Header = section.querySelector("[data-v21-header]");

  ScrollTrigger.create({
    trigger: section,
    start: "top 80%",
    once: true,
    onEnter: () => {
      if (motion) {
        gsap.fromTo(header,
          { opacity: 0, y: 8 },
          { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }
        );
        gsap.fromTo(content,
          { opacity: 0, y: 8 },
          { opacity: 1, y: 0, duration: 0.5, delay: 0.15, ease: "power2.out" }
        );
        if (rows.length) {
          gsap.fromTo(rows,
            { opacity: 0 },
            { opacity: 1, duration: 0.4, stagger: 0.08, delay: 0.3, ease: "power1.out" }
          );
        }
        if (v21Header) {
          gsap.fromTo(v21Header,
            { scale: 1 },
            { scale: 1.03, duration: 0.2, delay: 1.1, yoyo: true, repeat: 1, ease: "power1.inOut" }
          );
        }
      } else {
        gsap.set(header, { opacity: 1 });
        gsap.set(content, { opacity: 1 });
        gsap.set(rows, { opacity: 1 });
      }
    },
  });
}

// ─── Closing CTA ─────────────────────────────────────────────────────────

function initClosing(motion: boolean) {
  const section = document.querySelector("[data-section='closing']");
  if (!section) return;

  const line1 = section.querySelector("[data-closing='line1']");
  const line2 = section.querySelector("[data-closing='line2']");
  const cta = section.querySelector("[data-closing='cta']");

  ScrollTrigger.create({
    trigger: section,
    start: "top 80%",
    once: true,
    onEnter: () => {
      if (motion) {
        const tl = gsap.timeline({ defaults: { ease: "power2.out" } });
        if (line1) tl.fromTo(line1, { opacity: 0 }, { opacity: 1, duration: 0.5 });
        if (line2) tl.fromTo(line2, { opacity: 0 }, { opacity: 1, duration: 0.5 }, "+=0.3");
        if (cta) tl.fromTo(cta, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4 }, "-=0.1");
      } else {
        gsap.set([line1, line2, cta].filter(Boolean), { opacity: 1 });
      }
    },
  });
}
