"use client";

/**
 * LiveTradeCta — the "go live on SoDEX" call-to-action.
 *
 * Why it exists: Helix tags every routed order with its SoDEX builder
 * code, so each REAL fill streams a builder fee (Buildathon Builder
 * Race). But paper browsing earns nothing — only connected users who
 * actually trade generate fees. This banner makes the
 * connect → approve → trade path impossible to miss, so demo visitors
 * convert into fee-generating users instead of just reading paper data.
 *
 * State comes from the shared SodexAuth provider (the same source of
 * truth as the top-bar account button), so it can never disagree with
 * the rest of the UI. Its button opens the ONE global setup modal. In
 * demo mode it shows a prominent 3-step banner; once the browser is
 * live it collapses to a slim "✓ Connected · Open terminal" strip.
 */

import Link from "next/link";
import { useSodexAuth } from "@/components/sodex/auth/SodexAuthProvider";

type Context = "dashboard" | "index";

const COPY: Record<Context, { headline: string; sub: string }> = {
  dashboard: {
    headline: "Put Helix to work with real capital",
    sub: "Connect once to execute signals and deploy the AlphaIndex as real SoDEX orders — one click each.",
  },
  index: {
    headline: "Deploy this index live on SoDEX",
    sub: "One signature mirrors the AlphaIndex weights into real SoDEX orders, rebalanced as the book moves.",
  },
};

export function LiveTradeCta({ context = "dashboard" }: { context?: Context }) {
  const auth = useSodexAuth();

  // Avoid a pre-hydration flash of the wrong state on reload.
  if (auth.loading) return null;

  // Already live — a slim, non-nagging confirmation + a jump to the terminal.
  if (auth.ready) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-positive/30 bg-positive/10 px-3 py-2 text-[12px] text-positive">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-positive" />
        <span>
          ✓ Connected
          {auth.address
            ? ` · ${auth.address.slice(0, 6)}…${auth.address.slice(-4)}`
            : ""}{" "}
          — every order routes with Helix&apos;s builder code.
        </span>
        <Link
          href="/trade"
          className="ml-auto shrink-0 rounded border border-positive/40 bg-positive/10 px-2.5 py-1 text-[11px] font-medium text-positive hover:bg-positive/20"
        >
          Open terminal →
        </Link>
      </div>
    );
  }

  const { headline, sub } = COPY[context];
  const cta = auth.step === "wallet" ? "Connect SoDEX" : "Finish setup";

  return (
    <div className="relative overflow-hidden rounded-xl border border-accent/30 bg-gradient-to-br from-accent/10 via-surface to-surface p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="max-w-2xl">
          <div className="font-[var(--font-jetbrains-mono)] text-[10px] font-medium uppercase tracking-[0.2em] text-accent-2">
            Live trading · SoDEX mainnet
          </div>
          <h3 className="mt-1.5 font-[var(--font-fraunces)] text-[19px] font-light leading-tight text-fg">
            {headline}
          </h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
            {sub}{" "}
            <span className="text-fg-dim">
              Helix never holds your keys — you sign in your own wallet.
            </span>
          </p>

          {/* The three-step path, spelled out so there's no mystery. */}
          <ol className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px] text-fg-muted">
            <Step n={1} label="Connect wallet" />
            <Arrow />
            <Step n={2} label="Approve once (1 bp builder fee)" />
            <Arrow />
            <Step n={3} label="Trade from your browser" />
          </ol>
        </div>

        <div className="shrink-0">
          <button
            onClick={() => auth.openSetup()}
            className="dash-btn-primary inline-flex items-center gap-1.5 rounded-md border border-accent/50 bg-accent/20 px-4 py-2.5 text-[13px] font-medium text-accent-2 transition-colors hover:bg-accent/30"
          >
            {cta} →
          </button>
        </div>
      </div>
    </div>
  );
}

function Step({ n, label }: { n: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="flex h-4 w-4 items-center justify-center rounded-full border border-accent/40 bg-accent/15 text-[9px] font-semibold text-accent-2">
        {n}
      </span>
      {label}
    </span>
  );
}

function Arrow() {
  return <span className="text-fg-dim">→</span>;
}
