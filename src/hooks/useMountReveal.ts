"use client";

import { useEffect, useRef } from "react";

/**
 * Panel reveal on page mount — staggered fade-in with translateY.
 * Fires once per mount. Respects prefers-reduced-motion.
 *
 * Usage: const ref = useMountReveal<HTMLDivElement>(index);
 *        <div ref={ref} className="mount-reveal">…</div>
 *
 * The CSS class `mount-reveal` sets initial opacity: 0.
 * This hook adds `mount-reveal--visible` after a staggered delay.
 */
export function useMountReveal<T extends HTMLElement>(index = 0) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const delay = prefersReduced ? 0 : index * 60;
    const t = setTimeout(() => {
      el.classList.add("mount-reveal--visible");
    }, delay);

    return () => clearTimeout(t);
  }, [index]);

  return ref;
}

/**
 * Bulk panel reveal — returns a callback ref that adds the reveal
 * class to each child panel with stagger. Use on a container element.
 */
export function useBulkMountReveal() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const panels = container.querySelectorAll<HTMLElement>(".mount-reveal");
    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const timers: ReturnType<typeof setTimeout>[] = [];
    panels.forEach((panel, i) => {
      const delay = prefersReduced ? 0 : i * 60;
      timers.push(
        setTimeout(() => {
          panel.classList.add("mount-reveal--visible");
        }, delay),
      );
    });

    return () => timers.forEach(clearTimeout);
  }, []);

  return containerRef;
}
