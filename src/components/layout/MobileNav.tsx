"use client";

/**
 * Mobile navigation — a hamburger button (shown only below md) that opens
 * the sidebar as an off-canvas drawer over a backdrop. Reuses
 * SidebarContent so the mobile and desktop navs never drift apart. The
 * drawer closes when a link is tapped or the backdrop is clicked.
 */

import { useEffect, useState } from "react";
import { SidebarContent } from "./Sidebar";

export function MobileNav() {
  const [open, setOpen] = useState(false);

  // Lock body scroll while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        className="flex h-9 w-9 items-center justify-center rounded border border-line text-fg-muted transition-colors hover:border-line-2 hover:text-fg"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open ? (
        <div className="fixed inset-0 z-50">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          {/* Drawer */}
          <div className="absolute inset-y-0 left-0 flex w-64 max-w-[82%] flex-col border-r border-line bg-surface shadow-2xl">
            <div className="flex flex-1 flex-col" onClick={() => setOpen(false)}>
              <SidebarContent onNavigate={() => setOpen(false)} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
