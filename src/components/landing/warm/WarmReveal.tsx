"use client";

import { useEffect, useRef, type ReactNode } from "react";

interface WarmRevealProps {
  children: ReactNode;
  stagger?: number;
  immediate?: boolean;
  className?: string;
}

/**
 * Richer scroll-reveal for the warm direction.
 * Uses blur + slight scale + translate for a more dimensional entrance.
 */
export function WarmReveal({
  children,
  stagger = 0,
  immediate = false,
  className,
}: WarmRevealProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) {
      el.classList.add("warm-reveal--visible");
      return;
    }

    if (immediate) {
      requestAnimationFrame(() => el.classList.add("warm-reveal--visible"));
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.classList.add("warm-reveal--visible");
          observer.disconnect();
        }
      },
      { threshold: 0.12 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [immediate]);

  const classes = [
    "warm-reveal",
    stagger ? "warm-reveal--staggered" : "",
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
          ? ({ "--warm-reveal-stagger": `${stagger}ms` } as React.CSSProperties)
          : undefined
      }
    >
      {children}
    </div>
  );
}
