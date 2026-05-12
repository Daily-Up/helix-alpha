"use client";

import { useEffect, useRef, type ReactNode } from "react";

interface RevealProps {
  children: ReactNode;
  /** Stagger delay per child in ms. 0 = no stagger. */
  stagger?: number;
  /** If true, animate immediately on mount (for hero). */
  immediate?: boolean;
  className?: string;
}

export function Reveal({
  children,
  stagger = 0,
  immediate = false,
  className,
}: RevealProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) {
      el.classList.add("reveal--visible");
      return;
    }

    if (immediate) {
      requestAnimationFrame(() => el.classList.add("reveal--visible"));
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.classList.add("reveal--visible");
          observer.disconnect();
        }
      },
      { threshold: 0.15 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [immediate]);

  // The `reveal--staggered` class enables the per-child animation-delay
  // chain in globals.css. Toggling a class instead of using an
  // `[style*="--reveal-stagger"]` attribute selector lets the browser
  // hit the fast class-lookup path.
  const classes = [
    "reveal",
    stagger ? "reveal--staggered" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={ref}
      className={classes}
      style={
        stagger
          ? ({ "--reveal-stagger": `${stagger}ms` } as React.CSSProperties)
          : undefined
      }
    >
      {children}
    </div>
  );
}
